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
    return res.status(405).json({ answer: "Method not allowed" });
  }

  try {

    const { message } = req.body;

    if (!message) {
      return res.status(400).json({
        answer: "Message is required"
      });
    }

    // 1️⃣ Create embedding for the user question
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: message
    });

    const queryEmbedding = embeddingResponse.data[0].embedding;

    // 2️⃣ Retrieve relevant document chunks
    const { data: matches, error } = await supabase.rpc("match_documents", {
      query_embedding: queryEmbedding,
      match_threshold: 0.7,
      match_count: 5
    });

    if (error) {
      console.error(error);
      return res.status(500).json({
        answer: "Database search failed."
      });
    }

    const context = matches
      ?.map((doc: any) => doc.content_text)
      .join("\n\n") || "";

    // 3️⃣ Ask OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "You are an expert assistant for the Sustainable Livelihood Program (SLP) of DSWD. Answer only using the provided guideline context."
        },
        {
          role: "user",
          content: `Context:\n${context}\n\nQuestion:\n${message}`
        }
      ]
    });

    const answer = completion.choices[0].message.content || "No answer found.";

    return res.status(200).json({
      answer
    });

  } catch (error) {

    console.error("Chat error:", error);

    return res.status(500).json({
      answer: "Sorry, I encountered an error processing your request."
    });

  }
}