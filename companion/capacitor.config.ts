import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.iris.remote',
  appName: 'Iris',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    allowNavigation: ['192-210-231-152.nip.io', '192.210.231.152'],
  },
  android: {
    allowMixedContent: true,
    backgroundColor: '#f7f7f5',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      androidScaleType: 'CENTER_CROP',
      backgroundColor: '#f7f7f5',
      showSpinner: false,
      launchShowDuration: 800,
    },
  },
};

export default config;
