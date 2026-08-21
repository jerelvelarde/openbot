/**
 * A Bot's face.
 *
 * The web app draws it with `boring-avatars` from the Bot's `avatarSeed`, so a person moving between
 * the two surfaces recognises the same coworker. That library renders SVG, which React Native cannot
 * draw without another dependency — so this is a port of the same composition using plain Views: the
 * same string hash, the same default palette, the same three shapes at the same offsets.
 *
 * One honest difference: `boring-avatars` blurs the result and this does not, because a blur needs a
 * native module. So the same seed gives the same colours and the same arrangement, drawn crisply
 * rather than softly. That is a visible difference and worth stating rather than pretending away.
 */
import { View } from "react-native";

/** boring-avatars' default palette, so the same seed lands on the same colours as the web app. */
const PALETTE = ["#92A1C6", "#146A7C", "#F0AB3D", "#C271B4", "#C20D90"];

/** The library's own string hash. Reproduced exactly; a different hash is a different avatar. */
function hashOf(name: string): number {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash << 5) - hash + name.charCodeAt(index);
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function digit(number: number, place: number): number {
  return Math.floor((number / 10 ** place) % 10);
}

/** A signed unit: the same `getUnit` the library uses, including its sign trick. */
function unit(value: number, range: number, place?: number): number {
  const scaled = value % range;
  return place !== undefined && digit(value, place) % 2 === 0
    ? -scaled
    : scaled;
}

function colorAt(value: number): string {
  return PALETTE[value % PALETTE.length] as string;
}

/** The three shapes, in library order: background, bar, disc. */
function marble(seed: string) {
  const hash = hashOf(seed);
  const shape = (index: number) => ({
    color: colorAt(hash + index),
    translateX: unit(hash * (index + 1), 40 - (index + 17), 1),
    translateY: unit(hash * (index + 1), 40 - (index + 17), 2),
    rotate: unit(hash * (index + 1), 360),
    isSquare: digit(hash, 2) % 2 === 0,
  });
  return [shape(0), shape(1), shape(2)] as const;
}

/**
 * The Bot, at any size.
 *
 * `size` is the diameter. Everything inside is a fraction of it, so one component covers the 22px in
 * a list row and the 56px in a roster without a second set of numbers to keep in step.
 */
export function BotAvatar({
  seed,
  size = 40,
}: {
  /** The Bot's `avatarSeed`, which for every Bot the server ships is its id. */
  seed: string;
  size?: number;
}) {
  const [background, bar, disc] = marble(seed);
  const scale = size / 80;

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        overflow: "hidden",
        backgroundColor: background.color,
      }}
    >
      <View
        style={{
          position: "absolute",
          left: ((80 - 60) / 2) * scale,
          top: ((80 - 20) / 2) * scale,
          width: size,
          height: bar.isSquare ? size : size / 8,
          backgroundColor: bar.color,
          transform: [
            { translateX: bar.translateX * scale },
            { translateY: bar.translateY * scale },
            { rotate: `${bar.rotate}deg` },
          ],
        }}
      />
      <View
        style={{
          position: "absolute",
          left: size / 2 - size / 5,
          top: size / 2 - size / 5,
          width: (size / 5) * 2,
          height: (size / 5) * 2,
          borderRadius: size / 5,
          backgroundColor: disc.color,
          transform: [
            { translateX: disc.translateX * scale },
            { translateY: disc.translateY * scale },
          ],
        }}
      />
    </View>
  );
}

/**
 * A Bot with something waiting on it.
 *
 * The dot sits on the avatar rather than beside the name, because a list is scanned by picture before
 * it is read.
 */
export function BotAvatarWithDot({
  seed,
  size = 40,
  dot,
  ring = "#ffffff",
}: {
  seed: string;
  size?: number;
  dot?: string;
  /**
   * The colour the dot is cut out of, which is whatever surface the avatar sits on.
   *
   * It was a literal white. That is wrong on the roster rail, which sits on the page rather than on a
   * card, and it becomes a white ring on a dark surface everywhere the moment the app follows a
   * phone set to Dark.
   */
  ring?: string;
}) {
  return (
    <View style={{ width: size, height: size }}>
      <BotAvatar seed={seed} size={size} />
      {dot ? (
        <View
          style={{
            position: "absolute",
            right: -1,
            bottom: -1,
            width: size / 3.4,
            height: size / 3.4,
            borderRadius: size / 6.8,
            backgroundColor: dot,
            borderWidth: 2,
            borderColor: ring,
          }}
        />
      ) : null}
    </View>
  );
}
