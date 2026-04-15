import { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Validate environment variables
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NVIDIA_API_KEY) {
      console.error("Missing environment variables");
      return res.status(500).json({ 
        error: "Server configuration error: Missing required environment variables" 
      });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { userId, sessionId, message, history = [] } = req.body;

    if (!userId || !message) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Verify user exists and is approved
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();

    if (profileError || !profile || profile.status !== "approved") {
      return res.status(403).json({ error: "User not approved" });
    }

    // 1. Generate embedding for the user's message using Nvidia API
    let queryEmbedding;
    try {
      const embeddingResponse = await fetch(
        process.env.NVIDIA_EMBEDDINGS_API_URL || "https://integrate.api.nvidia.com/v1/embeddings",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.NVIDIA_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: process.env.NVIDIA_EMBEDDING_MODEL || "baai/bge-m3",
            input: message,
          }),
        }
      );

      if (!embeddingResponse.ok) {
        const error = await embeddingResponse.text();
        console.error("Nvidia embedding error:", error);
        throw new Error(`Nvidia API error: ${embeddingResponse.status}`);
      }

      const embeddingData = await embeddingResponse.json();
      queryEmbedding = embeddingData.data[0].embedding;
    } catch (embeddingError: any) {
      console.error("Error creating embedding:", embeddingError);
      return res.status(500).json({ 
        error: "Failed to process message. Please try again." 
      });
    }

    // 2. Vector search for relevant documents using RPC
    const { data: matchedChunks, error: matchError } = await supabase.rpc(
      "match_documents",
      {
        query_embedding: queryEmbedding,
        match_threshold: 0.3,
        match_count: 5,
      }
    );

    if (matchError) {
      console.error("Error matching documents:", matchError);
      return res.status(500).json({ error: "Error searching documents" });
    }

    // Build context from matched chunks
    const context = matchedChunks
      ?.map(
        (chunk: any) =>
          `[From: ${chunk.content.substring(0, 50)}...]\n${chunk.content}`
      )
      .join("\n\n---\n\n") || "No relevant documents found in knowledge base.";

    // Get source documents
    const sourceDocIds = [
      ...new Set(matchedChunks?.map((c: any) => c.document_id) || []),
    ];
    const { data: sourceDocs } = await supabase
      .from("documents")
      .select("id, file_name, folder")
      .in("id", sourceDocIds);

    // 3. Generate response using Nvidia API with RAG
    const systemPrompt = `You are the SLP Knowledge Assistant - a helpful AI that answers questions about the Sustainable Livelihood Program (SLP) of DSWD Philippines.

IMPORTANT RULES:
1. ONLY answer questions based on the provided context from SLP documents
2. If information is not in the context, clearly state: "I don't have information about this in the knowledge base"
3. Always cite your sources from the context
4. Be helpful, professional, and government-ready in tone
5. For numerical data, show it in tables when possible
6. Be concise but thorough

CONTEXT FROM SLP DOCUMENTS:
${context}

If the user asks for a specific document or form, help them locate it. If they ask for data analysis, try to provide it in table format using markdown.`;

    const messages = [
      ...history.map((msg: any) => ({
        role: msg.role,
        content: msg.content,
      })),
      { role: "user", content: message },
    ];

    let assistantMessage = "I encountered an error generating a response.";
    let tokensUsed = 0;

    try {
      const chatResponse = await fetch(
        "https://integrate.api.nvidia.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.NVIDIA_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: process.env.NVIDIA_CHAT_MODEL || "nvidia/llama-2-7b-chat",
            messages: [
              { role: "system", content: systemPrompt },
              ...messages,
            ],
            temperature: 0.7,
            max_tokens: 1500,
          }),
        }
      );

      if (!chatResponse.ok) {
        const error = await chatResponse.text();
        console.error("Nvidia chat error:", error);
        throw new Error(`Nvidia API error: ${chatResponse.status}`);
      }

      const chatData = await chatResponse.json();
      assistantMessage = chatData.choices?.[0]?.message?.content || "No response generated";
      tokensUsed = chatData.usage?.total_tokens || 0;
    } catch (chatError: any) {
      console.error("Error creating chat completion:", chatError);
      return res.status(500).json({ 
        error: "Failed to generate response. Please try again." 
      });
    }

    // Save message to chat history if sessionId provided (non-blocking)
    if (sessionId) {
      void supabase.from("chat_messages").insert([
        {
          session_id: sessionId,
          role: "user",
          content: message,
        },
        {
          session_id: sessionId,
          role: "assistant",
          content: assistantMessage,
        },
      ]);
    }

    // Log the chat (non-blocking)
    void supabase.from("chat_logs").insert({
      user_id: userId,
      message,
      response: assistantMessage,
      tokens_used: tokensUsed,
    });

    return res.status(200).json({
      answer: assistantMessage,
      sources: sourceDocs || [],
      matchedChunks: matchedChunks?.length || 0,
      tokensUsed: tokensUsed,
    });
  } catch (error: any) {
    console.error("Chat API Error:", error);
    // Always return JSON, never HTML
    return res.status(500).json({ 
      error: error?.message || "Internal server error. Please check console logs." 
    });
  }
}
