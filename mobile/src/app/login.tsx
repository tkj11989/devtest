import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, TextInput } from "react-native";

import { Body, Button, Card, ErrorText, Input, Muted, Row, Screen, Title } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";

export default function Login() {
  const { signIn } = useAuth();
  const [identifier, setIdentifier] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const codeRef = useRef<TextInput>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const sendCode = async () => {
    setError("");
    setBusy(true);
    try {
      const res = await api.requestOtp(identifier.trim());
      setSentTo(res.identifier);
      setCode("");
      setCooldown(res.resend_after);
      setTimeout(() => codeRef.current?.focus(), 100);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (value = code) => {
    if (value.length !== 6) return;
    setError("");
    setBusy(true);
    try {
      const res = await api.verifyOtp(identifier.trim(), value);
      await signIn(res.token, res.user); // the router guard then shows the home screen
    } catch (e) {
      setError((e as ApiError).message);
      setCode("");
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Screen>
        <Title style={{ fontSize: 26, marginTop: 48 }}>📄 Document Summarizer</Title>
        <Muted>Summarize documents and ask questions about them, privately, with a local AI model.</Muted>

        <Card style={{ marginTop: 16 }}>
          {sentTo === null ? (
            <>
              <Title>Log in</Title>
              <Muted>Enter your email address or mobile number (with country code). We’ll send you a 6-digit code.</Muted>
              <Input
                value={identifier}
                onChangeText={setIdentifier}
                placeholder="you@example.com or +91 98765 43210"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                textContentType="username"
                autoComplete="username"
                returnKeyType="send"
                onSubmitEditing={sendCode}
              />
              <Button label="Send code" onPress={sendCode} loading={busy} disabled={identifier.trim().length < 3} />
            </>
          ) : (
            <>
              <Title>Enter code</Title>
              <Body>
                We sent a code to <Body style={{ fontWeight: "700" }}>{sentTo}</Body>.
              </Body>
              <Input
                ref={codeRef}
                value={code}
                onChangeText={v => {
                  const digits = v.replace(/\D/g, "").slice(0, 6);
                  setCode(digits);
                  if (digits.length === 6) verify(digits);
                }}
                placeholder="••••••"
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                autoComplete="sms-otp"
                maxLength={6}
                style={{ fontSize: 26, letterSpacing: 10, textAlign: "center" }}
              />
              <Button label="Verify & log in" onPress={() => verify()} loading={busy} disabled={code.length !== 6} />
              <Row style={{ justifyContent: "space-between" }}>
                <Button
                  small
                  variant="ghost"
                  label={cooldown > 0 ? `Resend (${cooldown}s)` : "Resend code"}
                  disabled={cooldown > 0 || busy}
                  onPress={sendCode}
                />
                <Button
                  small
                  variant="ghost"
                  label="Change email/number"
                  onPress={() => { setSentTo(null); setError(""); }}
                />
              </Row>
            </>
          )}
          <ErrorText>{error}</ErrorText>
        </Card>
      </Screen>
    </KeyboardAvoidingView>
  );
}
