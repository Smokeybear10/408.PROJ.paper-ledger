import Workspace from "./workspace";

export const dynamic = "force-dynamic";

export default function Page() {
  const aiProvider = process.env.AI_PROVIDER === "codex" ? "codex" : process.env.GEMINI_API_KEY ? "gemini" : null;
  return <Workspace configuration={{ paypal: Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET), ai: aiProvider !== null, aiProvider }} />;
}
