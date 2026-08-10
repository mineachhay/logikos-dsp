import { describe, expect, it } from "vitest";
import { parseChildrenPage } from "./m365.js";

// Fixture copied verbatim from Microsoft's documented example response for
// GET /drives/{drive-id}/items/{item-id}/children, including its one
// slightly-inconsistent entry ("my sheet(1).xlsx" has neither a `file` nor
// a `folder` facet in the doc's own example) — a good real-world case for
// "skip anything that's neither".
const DOCUMENTED_EXAMPLE = {
  value: [
    { name: "myfile.jpg", size: 2048, file: {} },
    { name: "Documents", folder: { childCount: 4 } },
    { name: "Photos", folder: { childCount: 203 } },
    { name: "my sheet(1).xlsx", size: 197 },
  ],
  "@odata.nextLink": "https://graph.microsoft.com/v1.0/drives/abc/items/xyz/children?$skiptoken=abc",
};

describe("parseChildrenPage", () => {
  it("separates files from folders and carries nextLink through", () => {
    const result = parseChildrenPage(DOCUMENTED_EXAMPLE, "");
    expect(result.files.map((f) => f.path)).toEqual(["myfile.jpg"]);
    expect(result.folderNames).toEqual(["Documents", "Photos"]);
    expect(result.nextLink).toBe(DOCUMENTED_EXAMPLE["@odata.nextLink"]);
  });

  it("skips an item with neither a file nor a folder facet", () => {
    const result = parseChildrenPage(DOCUMENTED_EXAMPLE, "");
    expect(result.files.some((f) => f.path.includes("my sheet"))).toBe(false);
  });

  it("prefixes file paths with the current relative directory", () => {
    const result = parseChildrenPage(DOCUMENTED_EXAMPLE, "Documents/2024");
    expect(result.files[0].path).toBe("Documents/2024/myfile.jpg");
  });

  it("returns null nextLink when the response has no more pages", () => {
    const result = parseChildrenPage({ value: [] }, "");
    expect(result.nextLink).toBeNull();
    expect(result.files).toEqual([]);
    expect(result.folderNames).toEqual([]);
  });

  it("reads size and converts lastModifiedDateTime to epoch milliseconds", () => {
    const result = parseChildrenPage(
      { value: [{ name: "report.csv", size: 4096, file: {}, lastModifiedDateTime: "2026-01-15T10:30:00Z" }] },
      "",
    );
    expect(result.files[0].sizeBytes).toBe(4096);
    expect(result.files[0].mtimeMs).toBe(new Date("2026-01-15T10:30:00Z").getTime());
  });

  it("defaults size to 0 and mtime to 0 when the API omits them", () => {
    const result = parseChildrenPage({ value: [{ name: "empty.txt", file: {} }] }, "");
    expect(result.files[0].sizeBytes).toBe(0);
    expect(result.files[0].mtimeMs).toBe(0);
  });

  it("handles a response with no value array at all", () => {
    const result = parseChildrenPage({}, "");
    expect(result).toEqual({ files: [], folderNames: [], nextLink: null });
  });
});
