import { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {

  try {

    if (req.method !== "POST") {
      return res.status(200).json({
        answer: "Invalid request method."
      });
    }

    const { message } = req.body || {};

    if (!message) {
      return res.status(200).json({
        answer: "Please enter a question."
      });
    }

    const nvidiaResponse = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.NVIDIA_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.NVIDIA_CHAT_MODEL || "nvidia/llama-2-7b-chat",
        messages: [
          {
            role: "system",
            content: "You are an assistant for the Sustainable Livelihood Program (SLP) of DSWD."
          },
          {
            role: "user",
            content: message
          }
        ]
      })
    });

    const data = await nvidiaResponse.json();

    const answer =
      data?.choices?.[0]?.message?.content ||
      "No answer available.";

    return res.status(200).json({
      answer
    });

  } catch (error) {

    console.error("CHAT API ERROR:", error);

    return res.status(200).json({
      answer: "Server error occurred while processing your request."
    });

  }

}