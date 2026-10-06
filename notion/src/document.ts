import { parse } from "yaml";

import type { Document } from "./sync.js";

/** parseDocument returns undefined for unmarked files and validates marked files. */
export function parseDocument(sourcePath: string, source: string): Document | undefined {
  const content = source.replaceAll("\r\n", "\n");
  if (!content.startsWith("---\n")) {
    return undefined;
  }
  const frontmatterEnd = content.indexOf("\n---\n", 4);
  if (frontmatterEnd < 0) {
    return undefined;
  }

  const metadata = record(parse(content.slice(4, frontmatterEnd)), `frontmatter in ${sourcePath}`);
  if (!Object.hasOwn(metadata, "notion")) {
    return undefined;
  }
  const notion = optionalRecord(metadata.notion);
  if (stringValue(notion.relativePath).trim() !== "") {
    throw new Error(
      `marked document ${sourcePath} has a relativePath, which Notion wiki pages do not support`,
    );
  }
  const owners = stringList(notion.owners).map((owner) => owner.trim().toLowerCase());
  if (owners.some((owner) => owner === "")) {
    throw new Error(`marked document ${sourcePath} has an empty Notion owner`);
  }
  const tags = stringList(notion.tags).map((tag) => tag.trim());
  if (tags.some((tag) => tag === "")) {
    throw new Error(`marked document ${sourcePath} has an empty Notion tag`);
  }

  const body = content.slice(frontmatterEnd + 5);
  const heading = firstHeading(body);
  if (heading && heading.level !== 1 && stringValue(metadata.title).trim() === "") {
    throw new Error(`marked document ${sourcePath} must start with a level-one heading`);
  }
  if (heading?.level === 1) {
    if (heading.title === "") {
      throw new Error(`marked document ${sourcePath} has an empty level-one heading`);
    }
    return document(sourcePath, owners, tags, heading.title, removeLine(body, heading.line));
  }
  const title = stringValue(metadata.title).trim();
  if (title === "") {
    throw new Error(`marked document ${sourcePath} has no level-one heading`);
  }
  return document(sourcePath, owners, tags, title, body);
}

function document(
  sourcePath: string,
  owners: string[],
  tags: string[],
  title: string,
  body: string,
): Document {
  const normalizedBody = body.trim();
  return {
    sourcePath,
    repositoryBasePath: "",
    owners,
    tags,
    title,
    body: normalizedBody === "" ? "" : `${normalizedBody}\n`,
  };
}

function firstHeading(body: string): { level: number; title: string; line: number } | undefined {
  let fence = "";
  const lines = body.split("\n");
  for (const [line, value] of lines.entries()) {
    const marker = fenceMarker(value.trim());
    if (marker !== "") {
      fence = fence === "" ? marker : marker.startsWith(fence) ? "" : fence;
      continue;
    }
    if (fence !== "") {
      continue;
    }
    const match = /^(#{1,6})(?: |$)(.*)$/.exec(value);
    if (match) {
      return { level: match[1]?.length ?? 0, title: match[2]?.trim() ?? "", line };
    }
  }
  return undefined;
}

function fenceMarker(line: string): string {
  const match = /^(`{3,}|~{3,})/.exec(line);
  return match?.[1] ?? "";
}

function removeLine(body: string, line: number): string {
  const lines = body.split("\n");
  lines.splice(line, 1);
  return lines.join("\n");
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`parse ${name}: expected a mapping`);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringList(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("Notion owners and tags must be string lists");
  }
  return value as string[];
}
