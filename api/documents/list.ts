import { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { folder, limit = 100, offset = 0 } = req.query;

    let query = supabase
      .from("documents")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false });

    if (folder && folder !== "all") {
      query = query.eq("folder", folder);
    }

    query = query.range(Number(offset), Number(offset) + Number(limit) - 1);

    const { data, error, count } = await query;

    if (error) throw error;

    return res.status(200).json({
      documents: data,
      total: count,
      limit: Number(limit),
      offset: Number(offset),
    });
  } catch (error: any) {
    console.error("Error:", error);
    return res.status(500).json({ error: error.message });
  }
}
