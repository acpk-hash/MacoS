use serde::{Deserialize, Serialize};

const MAX_BODY_BYTES: usize = 2_000_000;
const MAX_ITEMS: usize = 80;

#[derive(Debug, Deserialize)]
pub struct TrendFetchRequest {
    pub url: Option<String>,
    pub kind: Option<String>,
    pub platform_id: Option<String>,
    pub api_url: Option<String>,
    pub expected_domain: Option<String>,
    pub keywords: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct TrendItem {
    pub title: String,
    pub url: String,
    pub source_url: String,
    pub snippet: String,
}

#[derive(Debug, Serialize)]
pub struct TrendFetchResult {
    pub source_url: String,
    pub fetched_at: i64,
    pub items: Vec<TrendItem>,
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    decode_entities(out.trim()).split_whitespace().collect::<Vec<_>>().join(" ")
}

fn abs_url(base: &str, href: &str) -> String {
    let h = href.trim();
    if h.starts_with("http://") || h.starts_with("https://") {
        return h.to_string();
    }
    if h.starts_with("//") {
        let scheme = base.split("://").next().unwrap_or("https");
        return format!("{}:{}", scheme, h);
    }
    if h.starts_with('/') {
        if let Some((scheme, rest)) = base.split_once("://") {
            let host = rest.split('/').next().unwrap_or(rest);
            return format!("{}://{}{}", scheme, host, h);
        }
    }
    let root = base.rsplit_once('/').map(|(p, _)| p).unwrap_or(base);
    format!("{}/{}", root.trim_end_matches('/'), h.trim_start_matches('/'))
}

fn extract_between<'a>(s: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let a = s.find(start)? + start.len();
    let b = s[a..].find(end)? + a;
    Some(&s[a..b])
}

fn parse_xml_items(source_url: &str, body: &str) -> Vec<TrendItem> {
    let mut out = Vec::new();
    for block in body.split("<item").skip(1) {
        let title = extract_between(block, "<title>", "</title>")
            .or_else(|| extract_between(block, "<title><![CDATA[", "]]></title>"))
            .map(strip_tags)
            .unwrap_or_default();
        let link = extract_between(block, "<link>", "</link>").map(strip_tags).unwrap_or_default();
        let desc = extract_between(block, "<description>", "</description>")
            .or_else(|| extract_between(block, "<summary>", "</summary>"))
            .map(strip_tags)
            .unwrap_or_default();
        if !title.is_empty() {
            out.push(TrendItem { title, url: abs_url(source_url, &link), source_url: source_url.to_string(), snippet: desc });
        }
        if out.len() >= MAX_ITEMS { break; }
    }
    if out.is_empty() {
        for block in body.split("<entry").skip(1) {
            let title = extract_between(block, "<title", "</title>")
                .and_then(|x| x.split_once('>').map(|(_, v)| v))
                .map(strip_tags)
                .unwrap_or_default();
            let link = block.split("<link").skip(1).find_map(|x| {
                let tag = x.split('>').next()?;
                extract_between(tag, "href=\"", "\"")
                    .or_else(|| extract_between(tag, "href='", "'"))
                    .map(|h| abs_url(source_url, h))
            }).unwrap_or_default();
            let desc = extract_between(block, "<summary", "</summary>")
                .and_then(|x| x.split_once('>').map(|(_, v)| v))
                .map(strip_tags)
                .unwrap_or_default();
            if !title.is_empty() {
                out.push(TrendItem { title, url: link, source_url: source_url.to_string(), snippet: desc });
            }
            if out.len() >= MAX_ITEMS { break; }
        }
    }
    out
}

fn parse_html_links(source_url: &str, body: &str) -> Vec<TrendItem> {
    let mut out = Vec::new();
    for part in body.split("<a").skip(1) {
        let tag_end = match part.find('>') { Some(i) => i, None => continue };
        let tag = &part[..tag_end];
        let href = extract_between(tag, "href=\"", "\"")
            .or_else(|| extract_between(tag, "href='", "'"));
        let Some(href) = href else { continue };
        let tail = &part[tag_end + 1..];
        let text = tail.split("</a>").next().map(strip_tags).unwrap_or_default();
        if text.chars().count() < 4 || text.chars().count() > 120 { continue; }
        if href.starts_with('#') || href.starts_with("javascript:") { continue; }
        out.push(TrendItem {
            title: text,
            url: abs_url(source_url, href),
            source_url: source_url.to_string(),
            snippet: String::new(),
        });
        if out.len() >= MAX_ITEMS { break; }
    }
    out
}

fn host_matches(url: &str, expected_domain: &str) -> bool {
    let expected = expected_domain.trim().to_lowercase();
    if expected.is_empty() { return true; }
    let Some(rest) = url.split("://").nth(1) else { return false };
    let host = rest.split('/').next().unwrap_or("").split('@').last().unwrap_or("").split(':').next().unwrap_or("").to_lowercase();
    host == expected || host.ends_with(&format!(".{}", expected))
}

fn parse_newsnow_items(source_url: &str, body: &str, expected_domain: &str) -> Result<Vec<TrendItem>, String> {
    let v: serde_json::Value = serde_json::from_str(body).map_err(|e| format!("newsnow JSON 解析失败: {e}"))?;
    let status = v.get("status").and_then(|x| x.as_str()).unwrap_or("");
    if status != "success" && status != "cache" {
        return Err(format!("newsnow 状态异常: {status}"));
    }
    let Some(items) = v.get("items").and_then(|x| x.as_array()) else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    for (idx, item) in items.iter().enumerate() {
        let title = item.get("title").and_then(|x| x.as_str()).unwrap_or("").trim();
        if title.is_empty() { continue; }
        let url = item.get("url").and_then(|x| x.as_str()).or_else(|| item.get("mobileUrl").and_then(|x| x.as_str())).unwrap_or("");
        if !expected_domain.trim().is_empty() && !host_matches(url, expected_domain) {
            continue;
        }
        out.push(TrendItem {
            title: title.to_string(),
            url: url.to_string(),
            source_url: source_url.to_string(),
            snippet: format!("Rank #{}", idx + 1),
        });
        if out.len() >= MAX_ITEMS { break; }
    }
    Ok(out)
}

fn filter_items(items: Vec<TrendItem>, keywords: &[String]) -> Vec<TrendItem> {
    if keywords.is_empty() { return items; }
    let ks: Vec<String> = keywords.iter().map(|k| k.trim().to_lowercase()).filter(|k| !k.is_empty()).collect();
    if ks.is_empty() { return items; }
    items.into_iter().filter(|it| {
        let hay = format!("{} {}", it.title, it.snippet).to_lowercase();
        ks.iter().any(|k| hay.contains(k))
    }).collect()
}

#[tauri::command]
pub async fn trends_fetch(req: TrendFetchRequest) -> Result<TrendFetchResult, String> {
    let kind = req.kind.as_deref().unwrap_or("web");
    let url_owned;
    let url = if kind == "platform" {
        let platform_id = req.platform_id.as_deref().unwrap_or("").trim();
        if platform_id.is_empty() { return Err("平台源缺少 platform_id".into()); }
        let api = req.api_url.as_deref().unwrap_or("https://newsnow.busiyi.world/api/s").trim().trim_end_matches('/');
        url_owned = format!("{}?id={}&latest", api, platform_id);
        url_owned.as_str()
    } else {
        url_owned = req.url.clone().unwrap_or_default();
        url_owned.trim()
    };
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("仅支持 http/https URL".into());
    }
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36")
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(url)
        .header("Accept", "application/json, text/plain, application/rss+xml, application/atom+xml, application/xml, text/xml, */*")
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .header("Cache-Control", "no-cache")
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let take = bytes.len().min(MAX_BODY_BYTES);
    let body = String::from_utf8_lossy(&bytes[..take]).to_string();
    let low = body[..body.len().min(512)].to_lowercase();
    let mut items = if kind == "platform" {
        parse_newsnow_items(url, &body, req.expected_domain.as_deref().unwrap_or(""))?
    } else if kind == "rss" || low.contains("<rss") || low.contains("<feed") || low.contains("<item") || low.contains("<entry") {
        parse_xml_items(url, &body)
    } else {
        parse_html_links(url, &body)
    };
    items = filter_items(items, &req.keywords.unwrap_or_default());
    Ok(TrendFetchResult { source_url: url.to_string(), fetched_at: now_ms(), items })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_newsnow_and_checks_expected_domain() {
        let body = r#"{"status":"cache","items":[{"title":"A","url":"https://www.zhihu.com/question/1"},{"title":"B","url":"https://evil.example/x"}]}"#;
        let items = parse_newsnow_items("https://newsnow.example/api/s?id=zhihu", body, "zhihu.com").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "A");
        assert_eq!(items[0].snippet, "Rank #1");
    }

    #[test]
    fn keyword_filter_is_case_insensitive() {
        let items = vec![TrendItem { title: "Rust Release".into(), url: String::new(), source_url: String::new(), snippet: String::new() }];
        assert_eq!(filter_items(items, &["rust".into()]).len(), 1);
    }

    #[test]
    fn parses_basic_rss() {
        let body = "<rss><channel><item><title>News</title><link>https://example.com/n</link><description>Hello</description></item></channel></rss>";
        let items = parse_xml_items("https://example.com/feed", body);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "News");
    }
}
