//! Literature search (v0.8): free academic APIs + AI analysis.
//!
//! Sources (no credentials required, called from Rust to avoid webview CORS):
//!   - arXiv  `https://export.arxiv.org/api/query` — Atom XML, parsed with a
//!     small hand-rolled extractor (no extra XML dependency).
//!   - OpenAlex `https://api.openalex.org/works` — JSON; abstracts arrive as an
//!     inverted index and are reconstructed locally.
//!
//! Analysis reuses the existing relay chat path (`providers::resolve_creds` +
//! `relay::chat_stream`) with the selected papers' titles + abstracts as
//! context. The result is returned in one shot (simple & reliable; no
//! streaming channel). Credentials never appear in logs or error strings.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::AppState;

/// Outbound HTTP timeout for the free literature APIs.
const HTTP_TIMEOUT_SECS: u64 = 20;
/// Per-paper abstract cap inside the analysis prompt (chars).
const ABSTRACT_PROMPT_CAP: usize = 2000;
/// Default analysis instruction when the user leaves it empty.
const DEFAULT_INSTRUCTION: &str = "总结这些文献的核心方法与研究缺口";

// -- Unified paper shape -------------------------------------------------------

/// One search hit, unified across sources.
#[derive(Debug, Clone, Serialize)]
pub struct LitPaper {
    /// Source-native id (arXiv id like `2101.00001v2`, OpenAlex `W...`).
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    /// Publication year as a string ("" when unknown).
    pub year: String,
    #[serde(rename = "abstract")]
    pub abstract_text: String,
    /// Best link to the full text / landing page.
    pub url: String,
    /// "arxiv" | "openalex"
    pub source: String,
}

/// Paper payload accepted by `lit_analyze` (subset the frontend checks send).
#[derive(Debug, Clone, Deserialize)]
pub struct LitPaperInput {
    pub title: String,
    #[serde(default)]
    pub authors: Vec<String>,
    #[serde(default)]
    pub year: String,
    #[serde(default, rename = "abstract")]
    pub abstract_text: String,
    #[serde(default)]
    pub source: String,
}

// -- Tiny XML helpers (arXiv Atom) ---------------------------------------------

/// Unescape the predefined XML entities (order matters: `&amp;` last).
fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// Collapse all whitespace runs (arXiv wraps titles/summaries across lines).
fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Inner contents of every `<tag ...>...</tag>` occurrence (non-nested tags).
fn xml_blocks<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let open_plain = format!("<{}>", tag);
    let open_attr = format!("<{} ", tag);
    let close = format!("</{}>", tag);
    let mut out = Vec::new();
    let mut pos = 0;
    while pos < xml.len() {
        let rest = &xml[pos..];
        let hit = match (rest.find(&open_plain), rest.find(&open_attr)) {
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None) => a,
            (None, Some(b)) => b,
            (None, None) => break,
        };
        let tag_start = pos + hit;
        let Some(gt) = xml[tag_start..].find('>') else { break };
        let content_start = tag_start + gt + 1;
        let Some(rel_end) = xml[content_start..].find(&close) else { break };
        out.push(&xml[content_start..content_start + rel_end]);
        pos = content_start + rel_end + close.len();
    }
    out
}

/// Inner text of the first `<tag ...>...</tag>` in `block`.
fn xml_tag_text(block: &str, tag: &str) -> Option<String> {
    xml_blocks(block, tag).first().map(|s| s.to_string())
}

/// Value of `name="..."` inside a single tag string.
fn xml_attr_value(tag: &str, name: &str) -> Option<String> {
    let needle = format!("{}=\"", name);
    let i = tag.find(&needle)? + needle.len();
    let j = tag[i..].find('"')? + i;
    Some(xml_unescape(&tag[i..j]))
}

/// Find the `<link title="pdf" href="...">` inside an arXiv entry.
fn arxiv_pdf_link(entry: &str) -> Option<String> {
    let mut pos = 0;
    while let Some(hit) = entry[pos..].find("<link") {
        let start = pos + hit;
        let end = entry[start..].find('>')? + start;
        let tag = &entry[start..=end];
        if tag.contains("title=\"pdf\"") {
            if let Some(href) = xml_attr_value(tag, "href") {
                return Some(href);
            }
        }
        pos = end + 1;
    }
    None
}

/// Parse an arXiv Atom response into unified papers.
pub(crate) fn parse_arxiv_atom(xml: &str) -> Vec<LitPaper> {
    let mut out = Vec::new();
    for entry in xml_blocks(xml, "entry") {
        let title = collapse_ws(&xml_unescape(
            &xml_tag_text(entry, "title").unwrap_or_default(),
        ));
        if title.is_empty() {
            continue;
        }
        let abs_url = xml_unescape(xml_tag_text(entry, "id").unwrap_or_default().trim());
        let id = abs_url
            .split("/abs/")
            .nth(1)
            .unwrap_or(&abs_url)
            .to_string();
        let authors = xml_blocks(entry, "author")
            .iter()
            .filter_map(|a| xml_tag_text(a, "name"))
            .map(|n| collapse_ws(&xml_unescape(&n)))
            .filter(|n| !n.is_empty())
            .collect::<Vec<_>>();
        let published = xml_tag_text(entry, "published").unwrap_or_default();
        let year: String = published.trim().chars().take(4).collect();
        let summary = collapse_ws(&xml_unescape(
            &xml_tag_text(entry, "summary").unwrap_or_default(),
        ));
        let url = arxiv_pdf_link(entry).unwrap_or_else(|| abs_url.clone());
        out.push(LitPaper {
            id,
            title,
            authors,
            year,
            abstract_text: summary,
            url,
            source: "arxiv".to_string(),
        });
    }
    out
}

// -- OpenAlex JSON parsing -----------------------------------------------------

/// Rebuild the abstract text from OpenAlex's `abstract_inverted_index`.
fn reconstruct_abstract(idx: Option<&Value>) -> String {
    let Some(map) = idx.and_then(|v| v.as_object()) else {
        return String::new();
    };
    let mut slots: Vec<(usize, &str)> = Vec::new();
    for (word, positions) in map {
        if let Some(arr) = positions.as_array() {
            for p in arr {
                if let Some(n) = p.as_u64() {
                    slots.push((n as usize, word.as_str()));
                }
            }
        }
    }
    slots.sort_by_key(|(i, _)| *i);
    slots
        .into_iter()
        .map(|(_, w)| w)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Parse an OpenAlex `/works` response into unified papers.
pub(crate) fn parse_openalex_json(body: &str) -> Result<Vec<LitPaper>, String> {
    let v: Value =
        serde_json::from_str(body).map_err(|e| format!("OpenAlex 响应解析失败: {e}"))?;
    let results = v
        .get("results")
        .and_then(|r| r.as_array())
        .ok_or_else(|| "OpenAlex 响应缺少 results 字段".to_string())?;

    let mut out = Vec::new();
    for w in results {
        let title = w
            .get("display_name")
            .or_else(|| w.get("title"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if title.is_empty() {
            continue;
        }
        let id_url = w.get("id").and_then(|x| x.as_str()).unwrap_or("");
        let id = id_url.rsplit('/').next().unwrap_or(id_url).to_string();
        let year = w
            .get("publication_year")
            .and_then(|y| y.as_i64())
            .map(|y| y.to_string())
            .unwrap_or_default();
        let mut authors = Vec::new();
        if let Some(arr) = w.get("authorships").and_then(|a| a.as_array()) {
            for a in arr {
                if let Some(name) = a
                    .pointer("/author/display_name")
                    .and_then(|n| n.as_str())
                {
                    authors.push(name.to_string());
                }
            }
        }
        let abstract_text = reconstruct_abstract(w.get("abstract_inverted_index"));
        let url = w
            .get("doi")
            .and_then(|d| d.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .or_else(|| {
                w.pointer("/primary_location/landing_page_url")
                    .and_then(|u| u.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| id_url.to_string());
        out.push(LitPaper {
            id,
            title,
            authors,
            year,
            abstract_text,
            url,
            source: "openalex".to_string(),
        });
    }
    Ok(out)
}

// -- HTTP search -----------------------------------------------------------------

fn lit_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .user_agent("agentboard/0.8 (literature search)")
        .build()
        .map_err(|e| format!("HTTP client 构建失败: {e}"))
}

async fn search_arxiv(query: &str, limit: u32) -> Result<Vec<LitPaper>, String> {
    let resp = lit_client()?
        .get("https://export.arxiv.org/api/query")
        .query(&[
            ("search_query", format!("all:{}", query)),
            ("start", "0".to_string()),
            ("max_results", limit.to_string()),
        ])
        .send()
        .await
        .map_err(|e| format!("arXiv 请求失败: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("arXiv 读取失败: {e}"))?;
    if !status.is_success() {
        return Err(format!("arXiv HTTP {}", status.as_u16()));
    }
    Ok(parse_arxiv_atom(&text))
}

async fn search_openalex(query: &str, limit: u32) -> Result<Vec<LitPaper>, String> {
    let resp = lit_client()?
        .get("https://api.openalex.org/works")
        .query(&[
            ("search", query.to_string()),
            ("per-page", limit.to_string()),
        ])
        .send()
        .await
        .map_err(|e| format!("OpenAlex 请求失败: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("OpenAlex 读取失败: {e}"))?;
    if !status.is_success() {
        return Err(format!("OpenAlex HTTP {}", status.as_u16()));
    }
    parse_openalex_json(&text)
}

// -- Analysis prompt -------------------------------------------------------------

/// Build the OpenAI messages array for a paper-set analysis.
pub(crate) fn build_analysis_messages(papers: &[LitPaperInput], instruction: &str) -> Vec<Value> {
    let mut ctx = String::new();
    for (i, p) in papers.iter().enumerate() {
        ctx.push_str(&format!("[{}] {}\n", i + 1, p.title.trim()));
        if !p.authors.is_empty() {
            ctx.push_str(&format!("作者: {}\n", p.authors.join(", ")));
        }
        if !p.year.is_empty() {
            ctx.push_str(&format!("年份: {}\n", p.year));
        }
        if !p.source.is_empty() {
            ctx.push_str(&format!("来源: {}\n", p.source));
        }
        if !p.abstract_text.trim().is_empty() {
            let a: String = p
                .abstract_text
                .trim()
                .chars()
                .take(ABSTRACT_PROMPT_CAP)
                .collect();
            ctx.push_str(&format!("摘要: {}\n", a));
        }
        ctx.push('\n');
    }
    vec![
        json!({
            "role": "system",
            "content": "你是一名严谨的科研文献分析助手。请仅基于用户提供的文献信息（标题、作者、年份、摘要）进行分析，用中文以 Markdown 格式输出；引用具体文献时使用其编号（如 [1]）。不要编造文献中不存在的结论。"
        }),
        json!({
            "role": "user",
            "content": format!("以下是 {} 篇文献：\n\n{}分析要求：{}", papers.len(), ctx, instruction)
        }),
    ]
}

// -- Tauri commands ----------------------------------------------------------------

/// Search a free literature source. `source`: "arxiv" (default) | "openalex".
#[tauri::command]
pub(crate) async fn lit_search(
    query: String,
    source: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<LitPaper>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("请输入搜索关键词".to_string());
    }
    let limit = limit.unwrap_or(10).clamp(1, 50);
    match source.as_deref().unwrap_or("arxiv") {
        "openalex" => search_openalex(q, limit).await,
        _ => search_arxiv(q, limit).await,
    }
}

/// Analyze checked papers via the existing relay chat path. Returns the full
/// Markdown analysis text in one shot.
#[tauri::command]
pub(crate) async fn lit_analyze(
    papers: Vec<LitPaperInput>,
    instruction: Option<String>,
    model: String,
    provider_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if papers.is_empty() {
        return Err("请先勾选至少一篇文献".to_string());
    }
    if model.trim().is_empty() {
        return Err("未指定分析模型（请先在设置中添加聊天服务商）".to_string());
    }
    let instr = instruction
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_INSTRUCTION.to_string());
    let messages = build_analysis_messages(&papers, &instr);
    let creds = crate::providers::resolve_creds(&state.db, provider_id.as_deref())?;
    let outcome = crate::relay::chat_stream(
        &creds,
        model.trim(),
        messages,
        CancellationToken::new(),
        |_delta| {},
    )
    .await?;
    if outcome.text.trim().is_empty() {
        return Err("模型未返回分析内容".to_string());
    }
    Ok(outcome.text)
}

// -- Unit tests --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const ARXIV_SAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">ArXiv Query: search_query=all:ckks</title>
  <entry>
    <id>http://arxiv.org/abs/2101.00001v2</id>
    <updated>2021-02-01T00:00:00Z</updated>
    <published>2021-01-05T10:00:00Z</published>
    <title>Faster CKKS Bootstrapping:
  A &amp; B Approach</title>
    <summary>  We present a faster bootstrapping
  method for CKKS with &lt;small&gt; error.  </summary>
    <author><name>Alice Zhang</name></author>
    <author><name>Bob Li</name></author>
    <link href="http://arxiv.org/abs/2101.00001v2" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2101.00001v2" rel="related" type="application/pdf"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2202.12345v1</id>
    <published>2022-06-30T00:00:00Z</published>
    <title>Second Paper</title>
    <summary>Another abstract.</summary>
    <author><name>Carol Wu</name></author>
  </entry>
</feed>"#;

    #[test]
    fn arxiv_atom_parses_entries() {
        let papers = parse_arxiv_atom(ARXIV_SAMPLE);
        assert_eq!(papers.len(), 2);

        let p = &papers[0];
        assert_eq!(p.id, "2101.00001v2");
        assert_eq!(p.title, "Faster CKKS Bootstrapping: A & B Approach");
        assert_eq!(p.authors, vec!["Alice Zhang", "Bob Li"]);
        assert_eq!(p.year, "2021");
        assert_eq!(
            p.abstract_text,
            "We present a faster bootstrapping method for CKKS with <small> error."
        );
        assert_eq!(p.url, "http://arxiv.org/pdf/2101.00001v2");
        assert_eq!(p.source, "arxiv");

        let q = &papers[1];
        assert_eq!(q.id, "2202.12345v1");
        assert_eq!(q.year, "2022");
        // No pdf link: falls back to the abs page.
        assert_eq!(q.url, "http://arxiv.org/abs/2202.12345v1");
    }

    #[test]
    fn arxiv_atom_ignores_feed_level_title() {
        // The feed-level <title> must not leak in as a paper (it sits outside
        // any <entry> block).
        let papers = parse_arxiv_atom(ARXIV_SAMPLE);
        assert!(papers.iter().all(|p| !p.title.contains("ArXiv Query")));
    }

    #[test]
    fn xml_unescape_handles_entities() {
        assert_eq!(
            xml_unescape("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;"),
            "a & b <c> \"d\" 'e'"
        );
    }

    const OPENALEX_SAMPLE: &str = r#"{
      "results": [
        {
          "id": "https://openalex.org/W123",
          "display_name": "Homomorphic Encryption Survey",
          "publication_year": 2023,
          "doi": "https://doi.org/10.1000/xyz",
          "authorships": [
            {"author": {"display_name": "Dana Kim"}},
            {"author": {"display_name": "Evan Ortiz"}}
          ],
          "abstract_inverted_index": {
            "survey": [3],
            "A": [0],
            "complete": [1, 2]
          }
        },
        {
          "id": "https://openalex.org/W456",
          "title": "No Abstract Work",
          "publication_year": 2020,
          "primary_location": {"landing_page_url": "https://example.org/p"},
          "authorships": []
        }
      ]
    }"#;

    #[test]
    fn openalex_parses_and_reconstructs_abstract() {
        let papers = parse_openalex_json(OPENALEX_SAMPLE).unwrap();
        assert_eq!(papers.len(), 2);

        let p = &papers[0];
        assert_eq!(p.id, "W123");
        assert_eq!(p.title, "Homomorphic Encryption Survey");
        assert_eq!(p.year, "2023");
        assert_eq!(p.authors, vec!["Dana Kim", "Evan Ortiz"]);
        assert_eq!(p.abstract_text, "A complete complete survey");
        assert_eq!(p.url, "https://doi.org/10.1000/xyz");
        assert_eq!(p.source, "openalex");

        let q = &papers[1];
        assert_eq!(q.title, "No Abstract Work");
        assert_eq!(q.abstract_text, "");
        // No DOI: landing page url fallback.
        assert_eq!(q.url, "https://example.org/p");
    }

    #[test]
    fn openalex_rejects_bodies_without_results() {
        assert!(parse_openalex_json("{}").is_err());
        assert!(parse_openalex_json("not json").is_err());
    }

    #[test]
    fn analysis_messages_include_papers_and_instruction() {
        let papers = vec![
            LitPaperInput {
                title: "Paper One".to_string(),
                authors: vec!["A".to_string(), "B".to_string()],
                year: "2021".to_string(),
                abstract_text: "First abstract.".to_string(),
                source: "arxiv".to_string(),
            },
            LitPaperInput {
                title: "Paper Two".to_string(),
                authors: vec![],
                year: String::new(),
                abstract_text: String::new(),
                source: String::new(),
            },
        ];
        let msgs = build_analysis_messages(&papers, DEFAULT_INSTRUCTION);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "system");
        let user = msgs[1]["content"].as_str().unwrap();
        assert!(user.contains("[1] Paper One"));
        assert!(user.contains("作者: A, B"));
        assert!(user.contains("First abstract."));
        assert!(user.contains("[2] Paper Two"));
        assert!(user.contains("2 篇文献"));
        assert!(user.contains(DEFAULT_INSTRUCTION));
    }

    #[test]
    fn analysis_messages_cap_long_abstracts() {
        let long = "x".repeat(ABSTRACT_PROMPT_CAP + 500);
        let papers = vec![LitPaperInput {
            title: "Long".to_string(),
            authors: vec![],
            year: String::new(),
            abstract_text: long,
            source: String::new(),
        }];
        let msgs = build_analysis_messages(&papers, "对比");
        let user = msgs[1]["content"].as_str().unwrap();
        let x_run = user.chars().filter(|&c| c == 'x').count();
        assert_eq!(x_run, ABSTRACT_PROMPT_CAP);
    }

    // -- Live test (network; run with: cargo test -- --ignored --nocapture) ------

    #[tokio::test]
    #[ignore]
    async fn live_arxiv_search() {
        let papers = search_arxiv("homomorphic encryption", 3)
            .await
            .expect("arXiv search should succeed");
        assert!(!papers.is_empty(), "expected at least one arXiv hit");
        for p in &papers {
            println!("[{}] {} ({}) {}", p.id, p.title, p.year, p.url);
            assert!(!p.title.is_empty());
        }
    }
}
