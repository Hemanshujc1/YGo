// The same @ygo/tokens plugin the web apps load: it replaces Tailwind's
// palette with the colour roles, and switches to the dark values with the
// system theme.
module.exports = {
  content: ["./src/**/*.tsx"],
  presets: [require("nativewind/preset")],
  plugins: [require("@ygo/tokens/tailwind").default],
};
