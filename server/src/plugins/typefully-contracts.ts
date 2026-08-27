import { z } from "zod";

const MEDIA_ID_MAX_CHARS = 240;
const PLAN_AT_MAX_CHARS = 64;
const PLATFORM_MIN_PROPERTIES = 1;
const UPDATE_DRAFT_FIELDS = [
  "platforms",
  "draftTitle",
  "share",
  "planAt",
] as const;

const positiveId = (description: string) =>
  z.number().int().positive().safe().describe(description);

const socialSetId = positiveId(
  "The positive integer id of the Typefully social set.",
);
const draftId = positiveId("The positive integer id of the Typefully draft.");
const limit = z
  .number()
  .int()
  .min(1)
  .max(50)
  .optional()
  .describe("At most 50 records to return.");
const offset = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe("How many records to skip.");

const mediaId = z.string().min(1).max(MEDIA_ID_MAX_CHARS);
const post = z.strictObject({
  text: z.string().max(50_000),
  mediaIds: z.array(mediaId).max(10).optional(),
});
const posts = z.array(post).max(50);
const platform = z.discriminatedUnion("enabled", [
  z.strictObject({ enabled: z.literal(true), posts: posts.min(1) }),
  z.strictObject({ enabled: z.literal(false), posts: posts.optional() }),
]);
const platforms = z
  .strictObject({
    x: platform.optional(),
    linkedin: platform.optional(),
    threads: platform.optional(),
    bluesky: platform.optional(),
    mastodon: platform.optional(),
  })
  .refine(
    (value) =>
      Object.values(value).filter((item) => item !== undefined).length >=
      PLATFORM_MIN_PROPERTIES,
    {
      message: "platforms must name at least one platform",
    },
  );

const DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

export function isFutureDateOrSlot(value: string): boolean {
  if (value === "next-free-slot") return true;
  const match = value.match(DATE_TIME_PATTERN);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "0").slice(0, 3).padEnd(3, "0"));
  const zone = match[8];
  const offsetSign = match[9];
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);

  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millisecond);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second ||
    local.getUTCMilliseconds() !== millisecond
  ) {
    return false;
  }
  if (
    zone !== "Z" &&
    (offsetHour > 23 || offsetMinute > 59 || offsetSign === undefined)
  ) {
    return false;
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) return false;

  const offsetMinutes =
    zone === "Z"
      ? 0
      : (offsetSign === "+" ? 1 : -1) * (offsetHour * 60 + offsetMinute);
  const roundTrip = new Date(timestamp + offsetMinutes * 60_000);
  return (
    roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() === month - 1 &&
    roundTrip.getUTCDate() === day &&
    roundTrip.getUTCHours() === hour &&
    roundTrip.getUTCMinutes() === minute &&
    roundTrip.getUTCSeconds() === second &&
    roundTrip.getUTCMilliseconds() === millisecond
  );
}

const futureDateTime = z
  .string()
  .max(PLAN_AT_MAX_CHARS)
  .regex(DATE_TIME_PATTERN)
  .refine((value) => isFutureDateOrSlot(value), {
    message: "must be a future ISO 8601 datetime with timezone",
  });
const futureDateOrSlot = z
  .union([z.literal("next-free-slot"), futureDateTime])
  .describe(
    'A future ISO 8601 datetime with timezone or "next-free-slot"; never "now".',
  );
const optionalDraftFields = {
  platforms: platforms.optional(),
  draftTitle: z.string().max(512).nullable().optional(),
  planAt: futureDateOrSlot.nullable().optional(),
};

export const TYPEFULLY_TOOL_NAMES = [
  "list_social_sets",
  "list_drafts",
  "get_draft",
  "create_draft",
  "update_draft",
  "upload_media",
  "remove_media",
  "schedule_draft",
  "delete_draft",
] as const;

export type TypefullyToolName = (typeof TYPEFULLY_TOOL_NAMES)[number];

export const typefullyContracts = {
  list_social_sets: z.strictObject({ limit, offset }),
  list_drafts: z.strictObject({ socialSetId, limit, offset }),
  get_draft: z.strictObject({ socialSetId, draftId }),
  create_draft: z.strictObject({
    socialSetId,
    platforms,
    draftTitle: optionalDraftFields.draftTitle,
    share: z.boolean().optional(),
    planAt: optionalDraftFields.planAt,
  }),
  update_draft: z
    .strictObject({
      socialSetId,
      draftId,
      ...optionalDraftFields,
      share: z.boolean().nullable().optional(),
    })
    .refine(
      ({ socialSetId: _socialSetId, draftId: _draftId, ...fields }) =>
        Object.values(fields).some((value) => value !== undefined),
      { message: "At least one reviewed draft field is required" },
    ),
  upload_media: z.strictObject({
    socialSetId,
    fileName: z
      .string()
      .min(1)
      .max(255)
      .regex(
        /^[a-zA-Z0-9_.()-]+\.(?:jpg|jpeg|png|webp|gif|mp4|mov|pdf)$/i,
        "fileName is not a supported media filename",
      ),
  }),
  remove_media: z.strictObject({
    socialSetId,
    draftId,
    platform: z.enum(["x", "linkedin", "threads", "bluesky", "mastodon"]),
    postIndex: z.number().int().min(0).max(49),
    mediaId,
  }),
  schedule_draft: z.strictObject({
    socialSetId,
    draftId,
    publishAt: futureDateOrSlot,
  }),
  delete_draft: z.strictObject({ socialSetId, draftId }),
} satisfies Record<TypefullyToolName, z.ZodType>;

type ContractMap = typeof typefullyContracts;
export type TypefullyCall = {
  [Name in TypefullyToolName]: {
    toolName: Name;
    args: z.output<ContractMap[Name]>;
  };
}[TypefullyToolName];

export function isTypefullyToolName(value: string): value is TypefullyToolName {
  return (TYPEFULLY_TOOL_NAMES as readonly string[]).includes(value);
}

export function parseTypefullyCall(
  toolName: string,
  args: unknown,
): { ok: true; call: TypefullyCall } | { ok: false; message: string } {
  if (!isTypefullyToolName(toolName)) {
    return {
      ok: false,
      message: `${toolName} is not a tool this connector implements. Refresh the stored tool list.`,
    };
  }
  const parsed = typefullyContracts[toolName].safeParse(args);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return {
      ok: false,
      message: `${path}${issue?.message ?? "Invalid Typefully tool arguments"}.`,
    };
  }
  return {
    ok: true,
    call: { toolName, args: parsed.data } as TypefullyCall,
  };
}

export function inputSchemaFor(
  toolName: TypefullyToolName,
): Record<string, unknown> {
  const schema = z.toJSONSchema(typefullyContracts[toolName]) as Record<
    string,
    unknown
  >;
  if (toolName === "create_draft" || toolName === "update_draft") {
    const properties = schema.properties;
    if (properties && typeof properties === "object") {
      const platformSchema = (properties as Record<string, unknown>).platforms;
      if (platformSchema && typeof platformSchema === "object") {
        (platformSchema as Record<string, unknown>).minProperties =
          PLATFORM_MIN_PROPERTIES;
      }
    }
  }
  if (toolName === "update_draft") {
    schema.anyOf = UPDATE_DRAFT_FIELDS.map((field) => ({ required: [field] }));
  }
  return schema;
}
