import { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export default async function handler(req: VercelRequest, res: VercelResponse) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {

    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message required" });
    }

    // Generate embedding for user query
    const queryEmbedding = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: message,
    });

    // Retrieve documents from database
    const { data: docs } = await supabase
      .from("documents")
      .select("content_text")
      .limit(5);

    const context = docs
      ?.map((d) => d.content_text)
      .join("\n\n")
      .slice(0, 8000);

    // Ask AI using retrieved context
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "You are an expert assistant for the Sustainable Livelihood Program (SLP). Answer using the provided guideline documents.",
        },
        {
          role: "user",
          content: `Context:\n${context}\n\nQuestion:\n${message}`,
        },
      ],
    });

    const answer = completion.choices[0].message.content;

    return res.status(200).json({
      answer,
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: "Chat processing failed",
    });

  }
}