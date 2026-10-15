import { afterEach, describe, expect, it, vi } from "vitest";

import { describeMetaError, editMessageTemplate, MetaApiError } from "./meta-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

function metaRefusal(error: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error }, { status: 400 })),
  );
}

describe("describeMetaError", () => {
  it("keeps Meta's explanation of a refused template edit", async () => {
    metaRefusal({
      message: "Invalid parameter",
      code: 100,
      error_subcode: 2388299,
      error_user_title: "Template can't be edited",
      error_user_msg: "This template was edited less than 24 hours ago.",
    });
    const err = await editMessageTemplate({
      metaTemplateId: "123",
      accessToken: "t",
      components: [],
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MetaApiError);
    // The short message stays as it was for existing callers.
    expect((err as Error).message).toBe("Invalid parameter");
    expect(describeMetaError(err, "Meta edit failed.")).toBe(
      "Invalid parameter — Template can't be edited: This template was edited less than 24 hours ago.",
    );
  });

  it("falls back to error_data.details, then to the message alone", () => {
    const withDetails = new MetaApiError("Invalid parameter", {
      httpStatus: 400,
      details: "Button example must match the button URL.",
    });
    expect(describeMetaError(withDetails, "x")).toBe(
      "Invalid parameter — Button example must match the button URL.",
    );
    expect(
      describeMetaError(new MetaApiError("Invalid parameter", { httpStatus: 400 }), "x"),
    ).toBe("Invalid parameter");
    expect(describeMetaError(new Error("boom"), "x")).toBe("boom");
    expect(describeMetaError("nope", "Meta edit failed.")).toBe("Meta edit failed.");
  });
});
