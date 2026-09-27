import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { strToU8, zipSync } from "fflate";
import { extractText, extractorFor } from "./textExtract.js";

const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

describe("extractorFor", () => {
  it("knows the formats it can read, and nothing else", () => {
    expect(extractorFor("HR/Payroll 2026.XLSX")).toBe("xlsx");
    expect(extractorFor("a/b.docx")).toBe("docx");
    expect(extractorFor("scan.pdf")).toBe("pdf");
    expect(extractorFor("notes.txt")).toBe("text");
    expect(extractorFor("old.doc")).toBeNull();
    expect(extractorFor("photo.jpg")).toBeNull();
  });
});

describe("extractText", () => {
  it("reads a Word document's body, headers and paragraphs", () => {
    const docx = zip({
      "word/document.xml": `<w:document><w:body><w:p><w:r><w:t>Employee: John Smith</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">SSN 123-45-6789 &amp; card</w:t></w:r></w:p></w:body></w:document>`,
      "word/header1.xml": `<w:hdr><w:p><w:r><w:t>CONFIDENTIAL</w:t></w:r></w:p></w:hdr>`,
      "word/styles.xml": `<w:t>not text</w:t>`,
    });
    const r = extractText("x.docx", docx);
    expect(r).toMatchObject({ extractor: "docx" });
    expect(r!.text).toContain("Employee: John Smith");
    expect(r!.text).toContain("SSN 123-45-6789 & card");
    expect(r!.text).toContain("CONFIDENTIAL");
    expect(r!.text).not.toContain("not text");
  });

  it("reads Excel shared strings and numeric cells — an ID typed as a number is only a <v>", () => {
    const xlsx = zip({
      "xl/sharedStrings.xml": `<sst><si><t>Name</t></si><si><t>Card</t></si><si><t>Jane Doe</t></si></sst>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row><c r="A2" t="s"><v>2</v></c><c r="B2"><v>4111111111111111</v></c><c r="C2" t="inlineStr"><is><t>jane@corp.example</t></is></c></row></sheetData></worksheet>`,
    });
    const r = extractText("x.xlsx", xlsx);
    expect(r!.text).toContain("Jane Doe");
    expect(r!.text).toContain("4111111111111111");
    expect(r!.text).toContain("jane@corp.example");
    expect(r!.text).not.toMatch(/^0$/m); // shared-string indexes aren't content
  });

  it("reads PowerPoint slides", () => {
    const pptx = zip({ "ppt/slides/slide1.xml": `<p:sld><a:t>Q3 salaries</a:t><a:t>Call 555-123-4567</a:t></p:sld>` });
    expect(extractText("deck.pptx", pptx)!.text).toContain("Call 555-123-4567");
  });

  it("reads the text a PDF draws, from a compressed content stream", () => {
    const content = deflateSync(Buffer.from("BT /F1 12 Tf 72 700 Td (Patient: Mary Major) Tj T* (SSN 123\\05545\\0556789) Tj ET"));
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n4 0 obj << /Length " + content.length + " /Filter /FlateDecode >>\nstream\n"),
      content,
      Buffer.from("\nendstream endobj\n%%EOF"),
    ]);
    const r = extractText("report.pdf", pdf);
    expect(r).toMatchObject({ extractor: "pdf" });
    expect(r!.text).toContain("Patient: Mary Major");
    expect(r!.text).toContain("SSN 123-45-6789"); // octal escapes decoded
  });

  it("says a PDF with no text layer has none, rather than returning nothing", () => {
    const pdf = Buffer.from("%PDF-1.4\n5 0 obj << /Length 4 /Filter /DCTDecode >>\nstream\n\xff\xd8\xff\xe0\nendstream endobj\n%%EOF", "latin1");
    expect(extractText("scan.pdf", pdf)).toEqual({ extractor: "pdf", text: null, note: "no text layer (scanned PDF?)" });
  });

  it("decodes UTF-16 text files and reports a damaged file instead of throwing", () => {
    expect(extractText("u.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("SSN 123-45-6789", "utf16le")]))!.text).toBe("SSN 123-45-6789");
    expect(extractText("broken.docx", Buffer.from("not a zip"))).toMatchObject({ extractor: "docx", text: null, note: expect.stringMatching(/couldn't read/) });
  });
});
