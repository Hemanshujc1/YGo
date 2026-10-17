// global.css is compiled by NativeWind's Metro step, not imported as a module.
declare module "*.css";

declare namespace NodeJS {
  interface ProcessEnv {
    /** The API's origin, such as `http://127.0.0.1:3000`. See README.md. */
    readonly EXPO_PUBLIC_API_BASE_URL?: string;
  }
}
