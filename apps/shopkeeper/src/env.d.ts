// global.css is compiled by NativeWind's Metro step, not imported as a module.
declare module "*.css";

declare namespace NodeJS {
  interface ProcessEnv {
    /** The API's origin, such as `http://127.0.0.1:3000`. See README.md. */
    readonly EXPO_PUBLIC_API_BASE_URL?: string;
    /** The support address that Help and a phone already in use point to. See README.md. */
    readonly EXPO_PUBLIC_SUPPORT_EMAIL?: string;
    /** This app's Play Store page; while unset, the update screen names the stores instead of showing a button. */
    readonly EXPO_PUBLIC_ANDROID_STORE_URL?: string;
    /** This app's App Store page; while unset, the update screen names the stores instead of showing a button. */
    readonly EXPO_PUBLIC_IOS_STORE_URL?: string;
  }
}
