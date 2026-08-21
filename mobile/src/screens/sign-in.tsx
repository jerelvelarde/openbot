/**
 * The first screen, when this build has to sign in.
 *
 * It has exactly one button, and that button opens the system browser. This app never sees a password,
 * never shows a password field, and has nothing to type into. That is the whole design: a companion
 * that could collect credentials would be a companion worth phishing.
 *
 * The web build behind the dev proxy never reaches this screen, because the browser is already
 * carrying its session cookie. Only a build pointed at a deployment over the network does.
 */
import { Text, View } from "react-native";
import { BotAvatar } from "../avatar";
import { useSession } from "../data/session";
import { space, type as type_ } from "../theme";
import { Body, Button, Card, Label, useColors } from "../ui";

/** Three Bots' faces, as the thing you are signing in to see. */
const FACES = ["risk-analyst", "general-assistant", "knowledge"];

export function SignInScreen({ label }: { label: string }) {
  const colors = useColors();
  const { state, signIn } = useSession();

  return (
    <View
      style={{
        flex: 1,
        width: "100%",
        // This screen does not go through `Screen`, so it carries the same measure itself. Without
        // it an iPad shows one button as wide as the window.
        maxWidth: 560,
        alignSelf: "center",
        backgroundColor: colors.background,
        padding: space.xl,
        justifyContent: "center",
        gap: space.xl,
      }}
    >
      <View style={{ alignItems: "center", gap: space.lg }}>
        <View style={{ flexDirection: "row" }}>
          {FACES.map((seed, index) => (
            <View
              key={seed}
              style={{
                marginLeft: index === 0 ? 0 : -14,
                borderRadius: 30,
                borderWidth: 3,
                borderColor: colors.background,
              }}
            >
              <BotAvatar seed={seed} size={54} />
            </View>
          ))}
        </View>
        <Text
          accessibilityRole="header"
          style={{
            ...type_.title,
            color: colors.foreground,
            textAlign: "center",
          }}
        >
          OpenBot
        </Text>
        <Text
          style={{
            ...type_.body,
            color: colors.muted,
            textAlign: "center",
            paddingHorizontal: space.md,
          }}
        >
          Your Bots keep working while you are not watching. This is where they
          come when they need you.
        </Text>
      </View>

      <View style={{ gap: space.md }}>
        {/* Disabled while the browser is open, because `openAuthSessionAsync` throws on a second
            call — into a discarded promise, which is nothing on screen at all. */}
        <Button
          disabled={state.status === "signing-in"}
          onPress={() => void signIn()}
          title={state.status === "signing-in" ? "Signing in…" : "Sign in"}
        />
        <Text
          style={{
            ...type_.small,
            color: colors.muted,
            textAlign: "center",
          }}
        >
          Opens your browser to sign in to {label}. This app never sees your
          password.
        </Text>
      </View>

      {state.status === "failed" ? (
        <Card muted>
          <Label>Did not work</Label>
          <Body muted>{state.reason}</Body>
        </Card>
      ) : null}
    </View>
  );
}
