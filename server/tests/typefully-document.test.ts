import { describe, expect, test } from "bun:test";
import {
  canonicalizeDraft,
  draftDocumentSchema,
  draftSummary,
} from "../src/typefully/document";

const baseDraft = () => ({
  title: "Launch notes",
  destinations: ["x", "linkedin"],
  socialSetId: "social-set-1",
  accountLabel: "OpenBot",
  posts: [
    {
      id: "post-1",
      x: "A short X post",
      linkedin: "A longer LinkedIn post",
    },
  ],
  media: [],
  scheduleAt: null,
});

describe("canonicalizeDraft", () => {
  test("serializes and hashes semantic values independently of object key insertion order", () => {
    const ordinary = baseDraft();
    const reordered = {
      scheduleAt: null,
      media: [],
      posts: [
        {
          linkedin: "A longer LinkedIn post",
          x: "A short X post",
          id: "post-1",
        },
      ],
      accountLabel: "OpenBot",
      socialSetId: "social-set-1",
      destinations: ["x", "linkedin"],
      title: "Launch notes",
    };

    const first = canonicalizeDraft(ordinary);
    const second = canonicalizeDraft(reordered);

    expect(first.document).toEqual(second.document);
    expect(first.serialized).toBe(second.serialized);
    expect(first.hash).toBe(second.hash);
    expect(first.serialized).toBe(
      '{"accountLabel":"OpenBot","destinations":["x","linkedin"],"media":[],"posts":[{"id":"post-1","linkedin":"A longer LinkedIn post","x":"A short X post"}],"scheduleAt":null,"socialSetId":"social-set-1","title":"Launch notes"}',
    );
    expect(first.hash).toBe(
      "06d0fbc90952307c325307b93e049cd3cba252e51edbc80c996b1f9e3cf1d212",
    );
  });

  test("normalizes line endings while preserving publication-significant whitespace", () => {
    const input = baseDraft();
    input.posts[0] = {
      id: "post-1",
      x: "  first\r\nsecond\rthird  ",
      linkedin: "\tlinked\r\n\r\npost \t",
    };
    input.media = [
      {
        id: "media-1",
        kind: "image",
        order: 0,
        altText: "  diagram\r\nwith detail  ",
        remoteId: null,
      },
    ];

    const { document } = canonicalizeDraft(input);

    expect(document.posts[0]?.x).toBe("  first\nsecond\nthird  ");
    expect(document.posts[0]?.linkedin).toBe("\tlinked\n\npost \t");
    expect(document.media[0]?.altText).toBe("  diagram\nwith detail  ");
  });

  test("normalizes destination and media order without reordering post blocks", () => {
    const input = baseDraft();
    input.destinations = ["linkedin", "x"];
    input.posts = [
      { id: "post-z", x: "first", linkedin: "first" },
      { id: "post-a", x: "second", linkedin: "second" },
    ];
    input.media = [
      {
        id: "media-z",
        kind: "video",
        order: 2,
        altText: "video",
        remoteId: "remote-z",
      },
      {
        id: "media-b",
        kind: "image",
        order: 1,
        altText: "second tie breaker",
        remoteId: null,
      },
      {
        id: "media-a",
        kind: "image",
        order: 0,
        altText: "first",
        remoteId: "remote-a",
      },
    ];

    const { document } = canonicalizeDraft(input);

    expect(document.destinations).toEqual(["x", "linkedin"]);
    expect(document.posts.map(({ id }) => id)).toEqual(["post-z", "post-a"]);
    expect(document.media.map(({ id }) => id)).toEqual([
      "media-a",
      "media-b",
      "media-z",
    ]);
  });

  test("rejects duplicate destinations and ambiguous media identities or orders", () => {
    expect(() =>
      canonicalizeDraft({
        ...baseDraft(),
        destinations: ["x", "x"],
      }),
    ).toThrow("Duplicate destination: x.");

    const media = {
      id: "media-1",
      kind: "image",
      order: 0,
      altText: "diagram",
      remoteId: null,
    };
    expect(() =>
      canonicalizeDraft({
        ...baseDraft(),
        media: [media, { ...media, order: 1 }],
      }),
    ).toThrow("Duplicate media id: media-1.");
    expect(() =>
      canonicalizeDraft({
        ...baseDraft(),
        media: [media, { ...media, id: "media-2" }],
      }),
    ).toThrow("Duplicate media order: 0.");
  });

  test("gives an actionable error for unsupported platform strings", () => {
    expect(() =>
      canonicalizeDraft({ ...baseDraft(), destinations: ["threads"] }),
    ).toThrow("Threads is not supported in OpenBot yet.");
    expect(() =>
      canonicalizeDraft({ ...baseDraft(), destinations: ["mastodon"] }),
    ).toThrow("Mastodon is not supported in OpenBot yet.");
  });

  test("enforces document, post, media, and identifier bounds", () => {
    expect(() =>
      draftDocumentSchema.parse({
        ...baseDraft(),
        title: "t".repeat(161),
      }),
    ).toThrow();
    expect(() =>
      draftDocumentSchema.parse({
        ...baseDraft(),
        posts: Array.from({ length: 51 }, (_, index) => ({
          id: `post-${index}`,
          x: "x",
          linkedin: "linkedin",
        })),
      }),
    ).toThrow();
    expect(() =>
      draftDocumentSchema.parse({
        ...baseDraft(),
        media: Array.from({ length: 21 }, (_, order) => ({
          id: `media-${order}`,
          kind: "image",
          order,
          altText: "",
          remoteId: null,
        })),
      }),
    ).toThrow();
    expect(() =>
      draftDocumentSchema.parse({
        ...baseDraft(),
        posts: [{ id: "p".repeat(121), x: "", linkedin: "" }],
      }),
    ).toThrow();
    expect(() =>
      draftDocumentSchema.parse({
        ...baseDraft(),
        posts: [{ id: "post-1", x: "x".repeat(100_001), linkedin: "" }],
      }),
    ).toThrow();
  });
});

describe("draftSummary", () => {
  test("returns a narrow summary with the trimmed document title", () => {
    const document = canonicalizeDraft({
      ...baseDraft(),
      title: "  Launch notes  ",
      media: [
        {
          id: "secret-remote-media",
          kind: "image",
          order: 0,
          altText: "private alt text",
          remoteId: "remote-secret",
        },
      ],
    }).document;

    const summary = draftSummary({
      id: "draft-1",
      document,
      version: 4,
      syncStatus: "synced",
    });

    expect(summary).toEqual({
      id: "draft-1",
      title: "Launch notes",
      destinations: ["x", "linkedin"],
      socialSetLabel: "OpenBot",
      mediaCount: 1,
      version: 4,
      syncStatus: "synced",
      proposalStatus: null,
    });
    expect(summary).not.toHaveProperty("document");
    expect(summary).not.toHaveProperty("posts");
    expect(summary).not.toHaveProperty("media");
    expect(summary).not.toHaveProperty("socialSetId");
    expect(summary).not.toHaveProperty("accountLabel");
    expect(summary).not.toHaveProperty("remoteId");
    expect(summary).not.toHaveProperty("credentials");
  });

  test("uses a bounded excerpt from the first enabled destination when title is empty", () => {
    const privateTail = "DO-NOT-LEAK-PAST-THE-BOUNDARY";
    const document = canonicalizeDraft({
      ...baseDraft(),
      title: "   ",
      destinations: ["linkedin"],
      posts: [
        {
          id: "post-1",
          x: "disabled X text",
          linkedin: `  ${"L".repeat(200)}${privateTail}`,
        },
      ],
    }).document;

    const summary = draftSummary({
      id: "draft-2",
      document,
      version: 1,
      syncStatus: "local",
      proposalStatus: "pending",
    });

    expect(summary.title.length).toBeLessThanOrEqual(160);
    expect(summary.title.startsWith("L")).toBe(true);
    expect(summary.title).not.toContain("disabled X text");
    expect(summary.title).not.toContain(privateTail);
    expect(summary.proposalStatus).toBe("pending");
  });
});
