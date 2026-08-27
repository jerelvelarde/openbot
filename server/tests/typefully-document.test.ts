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
  test("the document schema itself canonicalizes destination order", () => {
    const document = draftDocumentSchema.parse({
      ...baseDraft(),
      destinations: ["linkedin", "x"],
    });

    expect(document.destinations).toEqual(["x", "linkedin"]);
  });

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

  test("enforces destination minimum, maximum, and uniqueness", () => {
    expect(
      draftDocumentSchema.parse({
        ...baseDraft(),
        destinations: ["linkedin", "x"],
      }).destinations,
    ).toEqual(["x", "linkedin"]);
    expect(() =>
      draftDocumentSchema.parse({ ...baseDraft(), destinations: [] }),
    ).toThrow();
    expect(() =>
      draftDocumentSchema.parse({
        ...baseDraft(),
        destinations: ["x", "linkedin", "x"],
      }),
    ).toThrow();
    expect(() =>
      draftDocumentSchema.parse({
        ...baseDraft(),
        destinations: ["x", "x"],
      }),
    ).toThrow("Duplicate destination: x.");
  });

  test("enforces title, social-set, and account-label boundaries", () => {
    expect(
      draftDocumentSchema.parse({
        ...baseDraft(),
        title: "t".repeat(160),
        socialSetId: "s".repeat(120),
        accountLabel: "a".repeat(160),
      }),
    ).toMatchObject({
      title: "t".repeat(160),
      socialSetId: "s".repeat(120),
      accountLabel: "a".repeat(160),
    });
    expect(() =>
      draftDocumentSchema.parse({
        ...baseDraft(),
        title: "t".repeat(161),
      }),
    ).toThrow();
    expect(() =>
      draftDocumentSchema.parse({
        ...baseDraft(),
        socialSetId: "s".repeat(121),
      }),
    ).toThrow();
    expect(() =>
      draftDocumentSchema.parse({
        ...baseDraft(),
        accountLabel: "a".repeat(161),
      }),
    ).toThrow();
  });

  test("enforces post count, id, and body boundaries", () => {
    const posts = Array.from({ length: 50 }, (_, index) => ({
      id: `post-${index}`,
      x: index === 0 ? "x".repeat(100_000) : "",
      linkedin: "",
    }));
    expect(
      draftDocumentSchema.parse({ ...baseDraft(), posts }).posts,
    ).toHaveLength(50);
    expect(() =>
      draftDocumentSchema.parse({ ...baseDraft(), posts: [] }),
    ).toThrow();
    expect(() =>
      draftDocumentSchema.parse({
        ...baseDraft(),
        posts: [...posts, { id: "post-50", x: "", linkedin: "" }],
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

  test("enforces media count and descriptor boundaries", () => {
    const media = Array.from({ length: 20 }, (_, order) => ({
      id: order === 0 ? "i".repeat(120) : `media-${order}`,
      kind: "image",
      order,
      altText: order === 0 ? "a".repeat(10_000) : "",
      remoteId: order === 0 ? "r".repeat(240) : null,
    }));
    expect(
      draftDocumentSchema.parse({ ...baseDraft(), media }).media,
    ).toHaveLength(20);
    expect(() =>
      draftDocumentSchema.parse({
        ...baseDraft(),
        media: [...media, { ...media[0], id: "media-20", order: 20 }],
      }),
    ).toThrow();
    expect(() =>
      draftDocumentSchema.parse({
        ...baseDraft(),
        media: [{ ...media[0], id: "i".repeat(121) }],
      }),
    ).toThrow();
    expect(() =>
      draftDocumentSchema.parse({
        ...baseDraft(),
        media: [{ ...media[0], altText: "a".repeat(10_001) }],
      }),
    ).toThrow();
    expect(() =>
      draftDocumentSchema.parse({
        ...baseDraft(),
        media: [{ ...media[0], remoteId: "r".repeat(241) }],
      }),
    ).toThrow();
  });

  test("accepts ISO datetimes and rejects invalid schedule values", () => {
    expect(
      draftDocumentSchema.parse({
        ...baseDraft(),
        scheduleAt: "2026-08-27T12:34:56.000Z",
      }).scheduleAt,
    ).toBe("2026-08-27T12:34:56.000Z");
    expect(() =>
      draftDocumentSchema.parse({
        ...baseDraft(),
        scheduleAt: "August 27 sometime after lunch",
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

  test("checks enabled variants within each post before moving to a later post", () => {
    const document = canonicalizeDraft({
      ...baseDraft(),
      title: "",
      posts: [
        {
          id: "post-1",
          x: "",
          linkedin: "earliest post LinkedIn text",
        },
        {
          id: "post-2",
          x: "later post X text",
          linkedin: "later post LinkedIn text",
        },
      ],
    }).document;

    const summary = draftSummary({
      id: "draft-3",
      document,
      version: 2,
      syncStatus: "local",
    });

    expect(summary.title).toBe("earliest post LinkedIn text");
  });
});
