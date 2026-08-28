import { describe, expect, test } from "bun:test";
import { uploadPresignedMedia } from "../src/typefully/media-upload";

describe("Typefully presigned media upload", () => {
  test("refuses every representative non-global IPv4 and IPv6 class before sending bytes", async () => {
    const refused = [
      "0.0.0.0",
      "10.0.0.1",
      "100.100.100.200",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.0.0.170",
      "192.0.2.44",
      "192.88.99.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.44",
      "224.0.0.1",
      "240.0.0.1",
      "::",
      "::1",
      "::ffff:10.0.0.1",
      "64:ff9b::a00:1",
      "64:ff9b:1::1",
      "100::1",
      "2001::1",
      "2001:db8::1",
      "2002:0a00:0001::1",
      "3fff::1",
      "5f00::1",
      "fc00::1",
      "fe80::1",
      "fec0::1",
      "ff02::1",
      "2001:4860:0:1::5efe:a00:1",
    ];
    for (const address of refused) {
      let sent = false;
      await expect(
        uploadPresignedMedia(
          new File(["secret"], "post.png", { type: "image/png" }),
          "https://uploads.example.test/value",
          {
            resolve: async () => [
              { address, family: address.includes(":") ? 6 : 4 },
            ],
            put: async () => {
              sent = true;
              return 200;
            },
          },
        ),
      ).rejects.toThrow("Unsafe media upload address");
      expect(sent).toBe(false);
    }
  });

  test("allows globally routable resolved addresses while pinning the chosen address", async () => {
    const sent: string[] = [];
    for (const address of ["8.8.8.8", "2606:4700:4700::1111"]) {
      await uploadPresignedMedia(
        new File(["post"], "post.png", { type: "image/png" }),
        "https://uploads.example.test/value",
        {
          resolve: async () => [
            { address, family: address.includes(":") ? 6 : 4 },
          ],
          put: async ({ address: pinned }) => {
            sent.push(pinned.address);
            return 200;
          },
        },
      );
    }
    expect(sent).toEqual(["8.8.8.8", "2606:4700:4700::1111"]);
  });

  test("pins the validated address and refuses redirects without a second request", async () => {
    const sent: string[] = [];
    await expect(
      uploadPresignedMedia(
        new File(["post"], "post.png", { type: "image/png" }),
        "https://uploads.example.test/value",
        {
          resolve: async () => [{ address: "8.8.8.8", family: 4 }],
          put: async ({ address }) => {
            sent.push(address.address);
            return 308;
          },
        },
      ),
    ).rejects.toThrow("(308)");
    expect(sent).toEqual(["8.8.8.8"]);
  });
});
