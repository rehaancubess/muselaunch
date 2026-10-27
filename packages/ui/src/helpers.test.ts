import { describe, expect, it } from "vitest";
import { humanizeStatus, provenanceOfOrigin, statusKindOf } from "./components/badge";
import { domainOf, formatShortDate, initialsOf } from "./components/identity";
import { PIPELINE_STEPS, jobLabel } from "./components/job";

describe("ui helpers", () => {
  it("maps contract statuses to status kinds", () => {
    expect(statusKindOf("running")).toBe("running");
    expect(statusKindOf("needs_review")).toBe("attention");
    expect(statusKindOf("succeeded")).toBe("success");
    expect(statusKindOf("failed")).toBe("failed");
    expect(statusKindOf("something_new")).toBe("idle");
  });

  it("humanizes statuses without inventing meaning", () => {
    expect(humanizeStatus("needs_approval")).toBe("Needs approval");
    expect(humanizeStatus("not_configured")).toBe("Not connected");
    expect(humanizeStatus("concepts_ready")).toBe("Concepts ready");
  });

  it("labels media origins with honest provenance", () => {
    expect(provenanceOfOrigin("store_import")).toBe("imported");
    expect(provenanceOfOrigin("generated")).toBe("generated");
    expect(provenanceOfOrigin("upload")).toBe("upload");
    expect(provenanceOfOrigin("render")).toBe("render");
  });

  it("formats sources and identities", () => {
    expect(domainOf("https://www.example.com/a?b=1")).toBe("example.com");
    expect(domainOf("not a url")).toBeNull();
    expect(initialsOf("Maya Rao")).toBe("MR");
    expect(initialsOf("sam@studio.dev")).toBe("S");
    expect(formatShortDate("nope")).toBeNull();
  });

  it("keeps the campaign pipeline order from the spec", () => {
    expect(PIPELINE_STEPS).toEqual(["research", "concept", "storyboard", "assets", "composition", "render", "review"]);
    expect(jobLabel("render.final")).toBe("Rendering final video");
    expect(jobLabel("unknown.type")).toBe("Unknown type");
  });
});
