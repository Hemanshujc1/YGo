import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  TextInput: "TextInput",
  View: "View",
  Text: "Text",
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => [initial, () => undefined],
  };
});

const { PHONE_PREFIX, PhoneField } = await import("../src/phone-field");

function findTextInput(node: unknown): Record<string, unknown> | undefined {
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const element = node as { props: Record<string, unknown> };
  if (element.props.keyboardType === "phone-pad") return element.props;
  if (Array.isArray(element.props.children)) {
    for (const child of element.props.children) {
      const found = findTextInput(child);
      if (found) return found;
    }
  }
  return findTextInput(element.props.children);
}

describe("PhoneField (#482)", () => {
  const base = {
    label: "Customer phone",
    value: "9876543210",
    onChangeText: () => undefined,
    onSubmitEditing: () => undefined,
    editable: true,
  };

  it("defaults to tel autocomplete and telephoneNumber contentType for sign-in and profile", () => {
    const input = findTextInput(PhoneField(base));
    expect(input?.autoComplete).toBe("tel");
    expect(input?.textContentType).toBe("telephoneNumber");
  });

  it("turns autofill off when autofill={false} so a walk-in phone does not offer the owner's number", () => {
    const input = findTextInput(PhoneField({ ...base, autofill: false }));
    expect(input?.autoComplete).toBe("off");
    expect(input?.textContentType).toBe("none");
  });

  it("keeps tel autocomplete and telephoneNumber contentType when autofill={true}", () => {
    const input = findTextInput(PhoneField({ ...base, autofill: true }));
    expect(input?.autoComplete).toBe("tel");
    expect(input?.textContentType).toBe("telephoneNumber");
  });

  it("exports PHONE_PREFIX as +91", () => {
    expect(PHONE_PREFIX).toBe("+91");
  });
});
