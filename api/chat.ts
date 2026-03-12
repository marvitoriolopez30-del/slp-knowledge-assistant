import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY as string
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") {
      return res.status(200).json({ answer: "Only POST allowed." });
    }

    const { message } = req.body || {};

    if (!message) {
      return res.status(200).json({ answer: "Please enter a question." });
    }

    // Get documents as fallback context
    const { data: docs } = await supabase
      .from("documents")
      .select("content_text")
      .limit(5);

    const context =
      docs?.map((d) => d.content_text).join("\n\n") || "";

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "You are an assistant for the Sustainable Livelihood Program (SLP) of DSWD."
        },
        {
          role: "user",
          content: `Context:\n${context}\n\nQuestion:\n${message}`
        }
      ]
    });

    const answer =
      completion.choices?.[0]?.message?.content ||
      "No answer found.";

    return res.status(200).json({ answer });

  } catch (err: any) {
    console.error("CHAT API ERROR:", err);

    return res.status(200).json({
      answer: "Server error occurred while processing your request."
    });
  }
}