import { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Message required" });
  }

  return res.status(200).json({
    answer: `SLP stands for Sustainable Livelihood Program of the Department of Social Welfare and Development (DSWD). It provides livelihood opportunities for poor and vulnerable households.`
  });

}