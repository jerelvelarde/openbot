import { describe, expect, test } from "bun:test";
import { uploadPresignedMedia } from "../src/typefully/media-upload";

describe("Typefully presigned media upload", () => {
  test("refuses a hostname resolving to a private address before sending bytes", async () => {
    let sent = false;
    await expect(
      uploadPresignedMedia(
        new File(["secret"], "post.png", { type: "image/png" }),
        "https://uploads.example.test/value",
        {
          resolve: async () => [{ address: "169.254.169.254", family: 4 }],
          put: async () => {
            sent = true;
            return 200;
          },
        },
      ),
    ).rejects.toThrow("Unsafe media upload address");
    expect(sent).toBe(false);
  });

  test("pins the validated address and refuses redirects without a second request", async () => {
    const sent: string[] = [];
    await expect(
      uploadPresignedMedia(
        new File(["post"], "post.png", { type: "image/png" }),
        "https://uploads.example.test/value",
        {
          resolve: async () => [{ address: "203.0.113.44", family: 4 }],
          put: async ({ address }) => {
            sent.push(address.address);
            return 308;
          },
        },
      ),
    ).rejects.toThrow("(308)");
    expect(sent).toEqual(["203.0.113.44"]);
  });
});
