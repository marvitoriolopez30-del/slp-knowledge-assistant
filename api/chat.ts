import { VercelRequest, VercelResponse } from "@vercel/node";
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
      return res.status(200).json({
        answer: "Method not allowed"
      });
    }

    const { message } = req.body || {};

    if (!message) {
      return res.status(200).json({
        answer: "Please enter a question."
      });
    }

    let context = "";

    try {
      // Try semantic search
      const embedding = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: message
      });

      const queryEmbedding = embedding.data[0].embedding;

      const { data } = await supabase.rpc("match_documents", {
        query_embedding: queryEmbedding,
        match_threshold: 0.7,
        match_count: 5
      });

      if (data) {
        context = data.map((d: any) => d.content_text).join("\n\n");
      }

    } catch (semanticError) {
      console.log("Semantic search failed, fallback to normal search");
    }

    // fallback if semantic search empty
    if (!context) {
      const { data } = await supabase
        .from("documents")
        .select("content_text")
        .limit(5);

      if (data) {
        context = data.map(d => d.content_text).join("\n\n");
      }
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "You are an expert assistant for the Sustainable Livelihood Program (SLP). Use the provided document context to answer."
        },
        {
          role: "user",
          content: `Context:\n${context}\n\nQuestion:\n${message}`
        }
      ]
    });

    const answer =
      completion.choices?.[0]?.message?.content ||
      "I could not find the answer in the documents.";

    return res.status(200).json({ answer });

  } catch (error) {

    console.error("CHAT API ERROR:", error);

    return res.status(200).json({
      answer: "Sorry, I encountered an error processing your request."
    });

  }
}