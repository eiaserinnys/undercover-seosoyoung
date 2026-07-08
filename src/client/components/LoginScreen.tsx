import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Text, Heading } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/Stack";

export function LoginScreen({ error }: { error: string | null }) {
  return (
    <main className="login-shell">
      <Card padding={6} className="login-panel" aria-label="Slack 로그인">
        <VStack gap={5}>
          <VStack gap={1}>
            <Text type="supporting" weight="bold">
              Discord Ops
            </Text>
            <Heading level={1}>암행 서소영</Heading>
          </VStack>
          {error ? (
            <Card padding={3} variant="yellow">
              <Text type="supporting" wordBreak="break-word">
                {error}
              </Text>
            </Card>
          ) : null}
          <Button label="Slack으로 로그인" href="/auth/slack?next=/" variant="primary" />
        </VStack>
      </Card>
    </main>
  );
}
