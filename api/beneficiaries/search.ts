import { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import levenshtein from "js-levenshtein";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { name, region = "", municipality = "" } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Name is required" });
    }

    // Get all beneficiaries
    let query = supabase.from("beneficiaries").select("*");

    if (region) query = query.eq("region", region);
    if (municipality) query = query.eq("municipality", municipality);

    const { data: beneficiaries, error } = await query;

    if (error) throw error;

    // Calculate similarity scores
    const results = beneficiaries.map((b) => {
      const distance = levenshtein(
        name.toLowerCase(),
        b.name.toLowerCase()
      );
      const maxLength = Math.max(name.length, b.name.length);
      const similarity = ((maxLength - distance) / maxLength) * 100;
      return { ...b, similarity: Math.round(similarity) };
    });

    // Get best matches
    const bestMatches = results
      .filter((r) => r.similarity > 70)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5);

    const bestMatch = bestMatches[0] || null;

    return res.status(200).json({
      query: name,
      bestMatch,
      allMatches: bestMatches,
      totalBeneficiaries: beneficiaries.length,
    });
  } catch (error: any) {
    console.error("Error:", error);
    return res.status(500).json({ error: error.message });
  }
}
