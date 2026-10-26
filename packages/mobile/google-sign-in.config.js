const { withAppDelegate } = require("expo/config-plugins");

// The SDK's plugin installs the URL scheme; Expo must also forward its return URL.
module.exports = (config) => withAppDelegate(config, (mod) => {
  if (mod.modResults.language !== "swift") throw new Error("YGo Google sign-in needs Expo's Swift AppDelegate");
  let source = mod.modResults.contents;
  if (!source.includes("import GoogleSignIn")) source = `import GoogleSignIn\n${source}`;
  if (!source.includes("GIDSignIn.sharedInstance.handle(url)")) {
    const handler = "return super.application(app, open: url, options: options)";
    if (!source.includes(handler)) throw new Error("YGo Google sign-in could not find Expo's URL handler");
    source = source.replace(handler, "return GIDSignIn.sharedInstance.handle(url) || super.application(app, open: url, options: options)");
  }
  mod.modResults.contents = source;
  return mod;
});
