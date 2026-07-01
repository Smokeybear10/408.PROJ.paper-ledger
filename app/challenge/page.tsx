import ReferenceChallenge from "./reference-challenge";

export const dynamic = "force-dynamic";

export default function ChallengePage() {
  const provider = process.env.AI_PROVIDER === "codex" ? "codex" : process.env.GEMINI_API_KEY ? "gemini" : null;
  return <ReferenceChallenge provider={provider} />;
}
