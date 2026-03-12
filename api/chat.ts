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

    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
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

    const data = await openaiResponse.json();

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