// Android gets its push token through Firebase (#506, #507): GOOGLE_SERVICES_JSON is the path to the Firebase project's
// google-services.json, a git-ignored file locally or an EAS file variable in a cloud build. Without it the build has
// no Firebase, and the phone registers for no push.
module.exports = function googleServices(env) {
  const googleServicesFile = env.GOOGLE_SERVICES_JSON || undefined;
  return googleServicesFile ? { googleServicesFile } : {};
};
