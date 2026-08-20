/**
 * The phone the web build sits inside.
 *
 * On a device the app IS the screen and none of this renders. In a browser it is not, and a companion
 * stretched across a desktop window stops being an honest picture of itself: the line lengths, the
 * one-handed reach, and the balance between a transcript and its composer are all properties of a
 * narrow screen.
 *
 * So the web build draws a phone around itself, at a real phone's proportions — 393 × 852 points,
 * which is what an iPhone 16 Pro reports — and that is also what makes a recording of it legible
 * rather than a small app in a large empty page.
 *
 * The status bar is drawn, not faked from the real clock. A recording made at 04:12 that shows 04:12
 * tells the viewer about my evening rather than about the product, and a screenshot whose clock
 * changes between frames looks like a composite. It is a fixed 9:41 for the same reason every phone
 * mockup is.
 */
import type { ReactNode } from "react";
import { Text, useWindowDimensions, View } from "react-native";

export const SCREEN_WIDTH = 393;
export const SCREEN_HEIGHT = 852;
/** The black band around the glass. Thin, because a thick one is a toy. */
const BEZEL = 11;
const CORNER = 54;

/** The signal, wifi and battery marks. Shapes, not glyphs: a font may not have them. */
function StatusIcons({ color }: { color: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 2 }}>
        {[4, 6, 8, 10].map((height) => (
          <View
            key={height}
            style={{
              width: 3,
              height,
              borderRadius: 1,
              backgroundColor: color,
            }}
          />
        ))}
      </View>
      {/* Wifi, as three stacked arcs suggested by rounded bars of decreasing width. */}
      <View style={{ alignItems: "center", gap: 1.5 }}>
        <View
          style={{
            width: 13,
            height: 3,
            borderTopLeftRadius: 7,
            borderTopRightRadius: 7,
            backgroundColor: color,
          }}
        />
        <View
          style={{
            width: 8,
            height: 2.5,
            borderTopLeftRadius: 5,
            borderTopRightRadius: 5,
            backgroundColor: color,
          }}
        />
        <View
          style={{
            width: 3,
            height: 2.5,
            borderRadius: 2,
            backgroundColor: color,
          }}
        />
      </View>
      <View
        style={{
          width: 24,
          height: 12,
          borderRadius: 3.5,
          borderWidth: 1.2,
          borderColor: color,
          padding: 1.6,
          opacity: 0.9,
        }}
      >
        <View
          style={{
            flex: 1,
            width: "72%",
            borderRadius: 1.5,
            backgroundColor: color,
          }}
        />
      </View>
    </View>
  );
}

export function StatusBar({
  color,
  background,
}: {
  color: string;
  background: string;
}) {
  return (
    <View
      style={{
        height: 54,
        paddingTop: 14,
        paddingHorizontal: 26,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        backgroundColor: background,
      }}
    >
      <Text
        style={{
          fontSize: 15,
          fontWeight: "600",
          color,
          letterSpacing: 0.2,
        }}
      >
        9:41
      </Text>
      {/* The island sits over the middle of the bar, which is why the clock and the icons are apart. */}
      <View
        style={{
          position: "absolute",
          top: 8,
          left: SCREEN_WIDTH / 2 - 62,
          width: 124,
          height: 36,
          borderRadius: 18,
          backgroundColor: "#000000",
        }}
      />
      <StatusIcons color={color} />
    </View>
  );
}

/** The bar somebody swipes up on. Drawn because its absence is the thing that looks wrong. */
export function HomeIndicator({ color }: { color: string }) {
  return (
    <View style={{ alignItems: "center", paddingTop: 8, paddingBottom: 9 }}>
      <View
        style={{
          width: 140,
          height: 5,
          borderRadius: 3,
          backgroundColor: color,
          opacity: 0.35,
        }}
      />
    </View>
  );
}

/** Breathing room around the phone, so it never touches the edge of the window. */
const MARGIN = 28;
/**
 * How large the phone may grow.
 *
 * Everything inside is drawn from Views and text, so scaling up stays sharp rather than blurring —
 * but past a point a phone the size of a television stops reading as a phone.
 */
const MAX_SCALE = 1.9;

export function DeviceFrame({
  children,
  backdrop,
}: {
  children: ReactNode;
  backdrop: string;
}) {
  const window_ = useWindowDimensions();
  const outerWidth = SCREEN_WIDTH + BEZEL * 2;
  const outerHeight = SCREEN_HEIGHT + BEZEL * 2;

  /**
   * Fit the phone to the window, growing as well as shrinking.
   *
   * Without this the phone is whatever size 852 points happens to be in the current browser, which in
   * a wide window is a small app adrift in a large empty page — and a recording of that is mostly
   * background. Scaling means the same build reads correctly in a narrow window, a wide one, and a
   * video frame, without any of them being a special case.
   */
  const scale = Math.min(
    MAX_SCALE,
    (window_.width - MARGIN * 2) / outerWidth,
    (window_.height - MARGIN * 2) / outerHeight,
  );

  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: backdrop,
      }}
    >
      <View
        style={{
          width: outerWidth,
          height: outerHeight,
          borderRadius: CORNER + BEZEL,
          backgroundColor: "#0a0a0b",
          padding: BEZEL,
          // A single soft shadow, so the phone sits on the page rather than floating above it.
          boxShadow: "0 24px 70px rgba(0,0,0,0.34)",
          transform: [{ scale }],
        }}
      >
        <View
          style={{
            flex: 1,
            borderRadius: CORNER,
            overflow: "hidden",
          }}
        >
          {children}
        </View>
      </View>
    </View>
  );
}
