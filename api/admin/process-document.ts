import { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { documentId } = req.body;

    if (!documentId) {
      return res.status(400).json({ error: "Document ID required" });
    }

    // Document processing already handled by upload endpoint
    // This is a no-op endpoint for backwards compatibility
    return res.status(200).json({
      success: true,
      message: "Document processing complete",
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "Document processing failed",
    });
  }
}