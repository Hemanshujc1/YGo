export const fontFamily = "Inter";

export const fontWeights = {
  regular: "400",
  medium: "500",
  semibold: "600",
} as const;

export const fontSizes = {
  display: ["28px", { lineHeight: "40px" }],
  "title-large": ["24px", { lineHeight: "34px" }],
  title: ["20px", { lineHeight: "28px" }],
  headline: ["18px", { lineHeight: "26px" }],
  body: ["16px", { lineHeight: "24px" }],
  label: ["16px", { lineHeight: "24px" }],
  secondary: ["14px", { lineHeight: "21px" }],
  "small-label": ["13px", { lineHeight: "18px" }],
  caption: ["12px", { lineHeight: "18px" }],
} as const;
