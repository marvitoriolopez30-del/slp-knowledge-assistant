import { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message required" });
    }

    // Temporary response for testing
    return res.status(200).json({
      answer: `You asked: "${message}". The AI system will answer from uploaded SLP documents soon.`
    });

  } catch (error) {
    return res.status(500).json({ error: "Server error" });
  }
}