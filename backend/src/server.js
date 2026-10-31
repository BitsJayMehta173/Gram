import express from "express";
import cors from "cors";
import recommendationsRouter from "./routes/recommendations.js";
import blueprintRouter from "./routes/blueprint.js";
import mlRecommendationsRouter from "./routes/mlRecommendations.js";

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

app.use("/api", recommendationsRouter);
app.use("/api", blueprintRouter);
app.use("/api", mlRecommendationsRouter);

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Recommendation API listening on http://localhost:${PORT}`);
});
