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
            lineHeight: 22,
            paddingHorizontal: space.md,
          }}
        >
          Your Bots keep working while you are not watching. This is where they
          come when they need you.
        </Text>
      </View>

      <View style={{ gap: space.md }}>
        <Button onPress={() => void signIn()} title="Sign in" />
        <Text
          style={{
            ...type_.small,
            color: colors.muted,
            textAlign: "center",
          }}
        >
          Opens your browser. {label}
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
