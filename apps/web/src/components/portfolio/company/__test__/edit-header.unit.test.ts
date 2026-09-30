import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EditHeader } from "../edit-header";
import type { Company } from "../types";

// The portfolio components load `#trpc` only for its string enums; the real
// module pulls in the generated router, which isn't safe to import outside
// the Next.js build. Every enum member here reads as its own name, which is
// what a string enum's value is.
jest.mock("#trpc", () => {
  const stringEnum = new Proxy({}, { get: (_target, member) => member });
  return new Proxy({}, { get: () => stringEnum });
});

jest.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({}),
    views: {
      portfolio: {
        company: {
          updateCompanyInfo: {
            useMutation: () => ({ mutateAsync: jest.fn() }),
          },
        },
      },
    },
  },
}));

jest.mock("@/components/portfolio/toast", () => ({
  useToast: () => ({ success: jest.fn(), error: jest.fn() }),
}));

// The Save button sits in the modal's footer, which renders outside the
// modal's scrolling body. A `type="submit"` button only submits a <form> it is
// inside, so the form must enclose the footer or clicking Save does nothing.
describe("EditHeader", () => {
  it("renders the Save button inside the form it submits", () => {
    const company = {
      id: "company-1",
      name: "Example Co",
      legal_name: null,
      legal_status: "ACTIVE",
      otherNames: null,
      personal_website: null,
      description: null,
      country: "GB",
      // The modal reads only these fields of the full company overview.
    } as unknown as Company;

    const html = renderToStaticMarkup(
      createElement(EditHeader, {
        company,
        isOpen: true,
        onOpen: () => {},
        onClose: () => {},
      }),
    );

    const formOpen = html.indexOf("<form");
    const formClose = html.indexOf("</form>");
    const saveButton = html.indexOf('type="submit"');

    expect(formOpen).toBeGreaterThanOrEqual(0);
    expect(saveButton).toBeGreaterThan(formOpen);
    expect(saveButton).toBeLessThan(formClose);
  });
});
