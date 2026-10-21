import { type ReactNode, useEffect } from "react";
import { View } from "react-native";
import { Profile, type ProfileProps, type ProfileWords } from "./profile";
import { type AppSession, useSession } from "./session";
import { SignIn, type SignInProps } from "./sign-in";
import { Button } from "./sign-in-parts";
import type { SignInWords } from "./sign-in-words";
import { Text } from "./text";

/** Every word the gate's screens show, from the app's `strings.ts` (ADR-0009). */
export type SessionGateWords = {
  signIn: SignInWords;
  profile: ProfileWords;
  /** "Can't reach YGo", one line on what to do, and "Try again" (#155, Q3). */
  unreachable: { title: string; body: string; retry: string };
  /** C01's message after a sign-out that could not clear the phone's storage (#155, Q5). */
  notCleared: string;
};

type SessionGateProps = {
  session: AppSession;
  /** The app's own client: the calls C01, C14 and C02 make. */
  api: SignInProps["api"] & ProfileProps["api"];
  /** The address Help and C02's phone-in-use card open a new email to. */
  supportEmail: string;
  words: SessionGateWords;
  /** The app, shown once signed in with a name and phone. */
  children: ReactNode;
};

/**
 * Each root layout's screen picker (#155, Q2). At launch it asks the server
 * who is signed in, then shows a blank screen in the theme colour while it
 * waits, C01 and C14 while signed out, C02 until the name and phone are
 * saved, "Can't reach YGo" when no answer came, and the app once signed in.
 */
export function SessionGate({ session, api, supportEmail, words, children }: SessionGateProps) {
  const state = useSession(session);

  // Once per launch: a remount (Fast Refresh) never sends the person back to the blank screen.
  useEffect(() => {
    if (session.get().status === "checking") void session.check();
  }, [session]);

  switch (state.status) {
    case "checking":
      return <View className="flex-1 bg-bg" />;
    case "signed-out":
      return (
        <SignIn
          words={words.signIn}
          supportEmail={supportEmail}
          api={api}
          onSignedIn={session.signedIn}
          notice={state.notCleared ? words.notCleared : undefined}
        />
      );
    case "profile-needed":
      return (
        <Profile
          words={words.profile}
          supportEmail={supportEmail}
          api={api}
          onSaved={session.signedIn}
          onSignOut={session.signOut}
        />
      );
    case "unreachable":
      return (
        <View className="flex-1 justify-center bg-bg px-4">
          <Text accessibilityRole="header" className="text-title-large font-semibold text-text">
            {words.unreachable.title}
          </Text>
          <Text className="mt-2 text-body text-muted">{words.unreachable.body}</Text>
          <View className="mt-8">
            <Button label={words.unreachable.retry} onPress={() => void session.check()} />
          </View>
        </View>
      );
    case "signed-in":
      return children;
  }
}
