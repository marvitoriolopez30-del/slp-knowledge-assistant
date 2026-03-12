export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { file_path } = req.body;

    console.log("Processing document:", file_path);

    // Future: extract text from DOCX/PDF here

    return res.status(200).json({
      success: true,
      message: "Document processing completed"
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Processing failed"
    });
  }
}