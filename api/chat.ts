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

    const finalAnswer = `SLP stands for Sustainable Livelihood Program of the Department of Social Welfare and Development (DSWD). It aims to improve the socio-economic conditions of poor households through microenterprise and employment support.`;

    return res.status(200).json({
      answer: finalAnswer
    });

  } catch (error) {

    return res.status(500).json({
      error: "Chat processing failed"
    });

  }
}