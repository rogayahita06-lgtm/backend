// backend/server.js
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const PDFDocument = require("pdfkit");
const { createClient } = require("@supabase/supabase-js");

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || "*", credentials: true }));

/* ===============================
   SUPABASE
================================ */
const supabasePublic = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ===============================
   AUTH MIDDLEWARE
================================ */
function getBearerToken(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return null;
  return h.slice(7);
}

async function requireAuth(req, res, next) {
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ message: "Missing token" });

  const { data, error } = await supabasePublic.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ message: "Invalid token" });
  }
  req.user = data.user;
  next();
}

function requireAdmin(req, res, next) {
  const admins = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map(e => e.trim().toLowerCase());

  if (!admins.includes(req.user.email.toLowerCase())) {
    return res.status(403).json({ message: "Admin only" });
  }
  next();
}

/* ===============================
   HEALTH
================================ */
app.get("/", (_, res) => res.send("API KursusKu berjalan ✅"));

/* ===============================
   COURSES
================================ */
app.get("/api/courses", async (_, res) => {
  const { data, error } = await supabaseAdmin
    .from("courses")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ message: error.message });
  res.json(data);
});

app.post("/api/courses", requireAuth, requireAdmin, async (req, res) => {
  const { title, description, level, price, image_url } = req.body;

  const { data, error } = await supabaseAdmin
    .from("courses")
    .insert({
      title,
      description,
      level,
      price: Number(price) || 0,
      image_url: image_url || null
    })
    .select()
    .single();

  if (error) return res.status(500).json({ message: error.message });
  res.json(data);
});

app.put("/api/courses/:id", requireAuth, requireAdmin, async (req, res) => {
  const { error } = await supabaseAdmin
    .from("courses")
    .update(req.body)
    .eq("id", req.params.id);

  if (error) return res.status(500).json({ message: error.message });
  res.json({ message: "Updated" });
});

app.delete("/api/courses/:id", requireAuth, requireAdmin, async (req, res) => {
  const { error } = await supabaseAdmin
    .from("courses")
    .delete()
    .eq("id", req.params.id);

  if (error) return res.status(500).json({ message: error.message });
  res.json({ message: "Deleted" });
});

/* ===============================
   ENROLLMENT
================================ */
app.post("/api/enroll", requireAuth, async (req, res) => {
  const { course_id } = req.body;

  const { data: existing } = await supabaseAdmin
    .from("enrollments")
    .select("id")
    .eq("course_id", course_id)
    .eq("user_email", req.user.email)
    .maybeSingle();

  if (existing) {
    return res.status(400).json({ message: "Sudah terdaftar" });
  }

  const { error } = await supabaseAdmin.from("enrollments").insert({
    course_id,
    user_email: req.user.email,
    status: "terdaftar"
  });

  if (error) return res.status(500).json({ message: error.message });
  res.json({ message: "Pendaftaran berhasil" });
});

app.get("/api/my-enrollments", requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("enrollments")
    .select("course_id, status, courses(title)")
    .eq("user_email", req.user.email);

  if (error) return res.status(500).json({ message: error.message });

  res.json(data.map(e => ({
    course_id: e.course_id,
    course_title: e.courses.title,
    status: e.status
  })));
});

/* ===============================
   ADMIN VERIFIKASI
================================ */
app.get("/api/enrollments", requireAuth, requireAdmin, async (_, res) => {
  const { data } = await supabaseAdmin
    .from("enrollments")
    .select("id, user_email, status, courses(title)");

  res.json(data.map(e => ({
    id: e.id,
    user_email: e.user_email,
    course_title: e.courses.title,
    status: e.status
  })));
});

app.put("/api/enrollments/:id", requireAuth, requireAdmin, async (req, res) => {
  await supabaseAdmin
    .from("enrollments")
    .update({ status: req.body.status })
    .eq("id", req.params.id);

  res.json({ message: "Status updated" });
});

/* ===============================
   CERTIFICATE (PRO DESIGN)
================================ */
app.get("/api/certificates/:courseId", requireAuth, async (req, res) => {
  const { courseId } = req.params;

  const { data: enrollment, error } = await supabaseAdmin
    .from("enrollments")
    .select("status, courses(title)")
    .eq("course_id", courseId)
    .eq("user_email", req.user.email)
    .single();

  if (error || !enrollment || enrollment.status !== "lulus") {
    return res.status(403).json({ message: "Belum lulus" });
  }

  const nama =
    req.user.user_metadata?.full_name?.trim() ||
    req.user.email ||
    "Peserta";

  const courseTitle = enrollment.courses?.title || "Kursus";
  const tanggal = new Date().toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric"
  });

  const nomorSertifikat = `KK-${Date.now().toString().slice(-6)}`;

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const chunks = [];

  doc.on("data", d => chunks.push(d));
  doc.on("end", () => {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="sertifikat.pdf"');
    res.send(Buffer.concat(chunks));
  });

  /* ===== BORDER ===== */
  doc
    .lineWidth(3)
    .rect(20, 20, 555, 802)
    .stroke("#1E3A8A");

  doc
    .lineWidth(1)
    .rect(30, 30, 535, 782)
    .stroke("#CBD5E1");

  /* ===== HEADER ===== */
  doc
    .font("Helvetica-Bold")
    .fontSize(28)
    .fillColor("#1E3A8A")
    .text("SERTIFIKAT", 0, 110, { align: "center" });

  doc
    .fontSize(20)
    .fillColor("#000000")
    .text("KELULUSAN", { align: "center" });

  doc.moveDown(1);

  doc
    .moveTo(150, 200)
    .lineTo(450, 200)
    .stroke("#1E3A8A");

  /* ===== BODY ===== */
  doc.moveDown(3);

  doc
    .font("Helvetica")
    .fontSize(12)
    .fillColor("#000000")
    .text("Diberikan kepada:", { align: "center" });

  doc.moveDown(1);

  doc
    .font("Helvetica-Bold")
    .fontSize(22)
    .text(nama, { align: "center" });

  doc.moveDown(2);

  doc
    .font("Helvetica")
    .fontSize(12)
    .text("Atas keberhasilannya menyelesaikan kursus:", {
      align: "center"
    });

  doc.moveDown(1);

  doc
    .font("Helvetica-Bold")
    .fontSize(18)
    .text(courseTitle, { align: "center" });

  doc.moveDown(3);

  doc
    .fontSize(12)
    .font("Helvetica")
    .text(`Tanggal: ${tanggal}`, { align: "center" });

  /* ===== FOOTER ===== */
  doc.moveDown(4);

  doc
    .fontSize(10)
    .fillColor("#374151")
    .text(
      `Nomor Sertifikat: ${nomorSertifikat}`,
      { align: "center" }
    );

  doc.moveDown(1);

  doc
    .fontSize(10)
    .fillColor("#374151")
    .text(
      "KursusKu — Platform Pembelajaran Bahasa Indonesia",
      { align: "center" }
    );

  doc.end();
});





/* ===============================
   START SERVER
================================ */
app.listen(process.env.PORT || 3000, () =>
  console.log("✅ Server running")
);
