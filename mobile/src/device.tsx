/**
 * The phone the web build sits inside.
 *
 * On a device the app IS the screen and none of this renders. In a browser it is not, and a companion
 * stretched across a desktop window stops being an honest picture of itself: the line lengths, the
 * one-handed reach, and the balance between a transcript and its composer are all properties of a
 * narrow screen.
 *
 * So the web build draws a phone around itself, at a real phone's proportions — 393 × 852 points,
 * which is what an iPhone 14 Pro, 15 Pro and 16 report — and that is also what makes a recording of
 * it legible rather than a small app in a large empty page. (A 16 Pro is 402 × 874; the smaller box
 * is the right one to design in, because a layout that fits 393 fits 402 and not the reverse.)
 *
 * The status bar is drawn, not faked from the real clock. A recording made at 04:12 that shows 04:12
 * tells the viewer about my evening rather than about the product, and a screenshot whose clock
 * changes between frames looks like a composite. It is a fixed 9:41 for the same reason every phone
 * mockup is.
 */
import type { ReactNode } from "react";
import { ScrollView, Text, useWindowDimensions, View } from "react-native";

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
        // No top padding: with it the content box centres 8pt below the island's centre, which is
        // the one alignment a viewer checks without being asked to.
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
          top: 11,
          left: SCREEN_WIDTH / 2 - 62.5,
          width: 125,
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
    // 34pt in total, which is what a gesture iPhone reserves. It was 22, so the tab bar above it sat
    // lower than the hardware would put it.
    <View style={{ alignItems: "center", paddingTop: 12, paddingBottom: 17 }}>
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
   * Fit the phone to the window, growing as well as shrinking — but never below 1.
   *
   * Without any scaling the phone is whatever size 852 points happens to be in the current browser,
   * which in a wide window is a small app adrift in a large empty page, and a recording of that is
   * mostly background.
   *
   * The floor is what makes browser zoom work. `useWindowDimensions` reports CSS pixels, so at 200%
   * the height term halves against a constant frame and the app came out marginally SMALLER on the
   * glass — with `overflow: hidden` and no pannable area there was no way to make any text bigger at
   * all, on a target people do drive with a keyboard and a mouse.
   */
  const scale = Math.max(
    1,
    Math.min(
      MAX_SCALE,
      (window_.width - MARGIN * 2) / outerWidth,
      (window_.height - MARGIN * 2) / outerHeight,
    ),
  );

  return (
    <ScrollView
      contentContainerStyle={{
        minWidth: "100%",
        minHeight: "100%",
        alignItems: "center",
        justifyContent: "center",
        padding: MARGIN,
      }}
      style={{ flex: 1, backgroundColor: backdrop }}
    >
      {/*
        A transform does not change the layout box, so at a scale above 1 the phone would overflow a
        container that still believed it was 415 x 874 and nothing could be scrolled to. This wrapper
        is the real size; the frame inside it is drawn from the top left and scaled into place.
      */}
      <View style={{ width: outerWidth * scale, height: outerHeight * scale }}>
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
            transformOrigin: "top left",
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
    </ScrollView>
  );
}
