import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { CategoriesResponse, Category, CategoryParams, CreateCategoryBody, EditCategoryBody, ErrorEnvelope } from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { adminSignedIn } from "../admin";
import { deriveKeys } from "../tokens";

const categorySql = `SELECT c.id, c.parent_id AS "parentId", c.name, c.active,
  (c.active AND COALESCE(p.active, true)) AS "effectiveActive"
  FROM categories c LEFT JOIN categories p ON p.id = c.parent_id`;

async function category(client: PoolClient, id: string): Promise<Category> {
  const row = await client.query<Category>(`${categorySql} WHERE c.id = $1`, [id]);
  if (!row.rows[0]) throw new Error("Saved category missing");
  return row.rows[0];
}

export function registerCategoryRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const response = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope };

  app.get("/v1/admin/categories", { schema: { response: { 200: CategoriesResponse, ...response } } }, async (request, reply) => {
    if (!await adminSignedIn(request, reply, auth)) return reply;
    const rows = await pool.query<Category>(`${categorySql} ORDER BY p.name NULLS FIRST, c.name`);
    return { categories: rows.rows };
  });

  app.post("/v1/admin/categories", { schema: { body: CreateCategoryBody, response: { 201: Category, ...response } } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    const { name, parentId } = request.body as CreateCategoryBody;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const member = await client.query("SELECT 1 FROM admin_memberships WHERE account_id = $1 FOR KEY SHARE", [who.accountId]);
      if (!member.rowCount) return reply.code(403).send({ error: { code: "FORBIDDEN" } });
      if (parentId) {
        const parent = await client.query("SELECT 1 FROM categories WHERE id = $1 AND parent_id IS NULL", [parentId]);
        if (!parent.rowCount) return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["parentId"] } });
      }
      const inserted = await client.query<{ id: string }>("INSERT INTO categories (name, parent_id) VALUES ($1, $2) RETURNING id", [name, parentId]);
      const id = inserted.rows[0]?.id;
      if (!id) throw new Error("Category insert returned no ID");
      await client.query("INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason) VALUES ($1, 'category.create', $2, 'category', 'Category created')", [who.accountId, id]);
      const saved = await category(client, id);
      await client.query("COMMIT");
      return reply.code(201).send(saved);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") return reply.code(409).send({ error: { code: "CATEGORY_NAME_IN_USE" } });
      throw error;
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  app.patch("/v1/admin/categories/:id", { schema: { params: CategoryParams, body: EditCategoryBody, response: { 200: Category, ...response } } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as { id: string };
    const body = request.body as EditCategoryBody;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const member = await client.query("SELECT 1 FROM admin_memberships WHERE account_id = $1 FOR KEY SHARE", [who.accountId]);
      if (!member.rowCount) return reply.code(403).send({ error: { code: "FORBIDDEN" } });
      const old = await client.query<Category>("SELECT id, parent_id AS \"parentId\", name, active FROM categories WHERE id = $1 FOR UPDATE", [id]);
      if (!old.rows[0]) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      if (old.rows[0].active && body.active === false && !body.reason) return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["reason"] } });
      const next = { name: body.name ?? old.rows[0].name, parentId: body.parentId === undefined ? old.rows[0].parentId : body.parentId, active: body.active ?? old.rows[0].active };
      if (next.parentId) {
        const parent = await client.query("SELECT 1 FROM categories WHERE id = $1 AND parent_id IS NULL", [next.parentId]);
        if (!parent.rowCount || next.parentId === id) return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["parentId"] } });
      }
      if (next.parentId !== old.rows[0].parentId) {
        const children = await client.query("SELECT 1 FROM categories WHERE parent_id = $1 LIMIT 1", [id]);
        if (children.rowCount && next.parentId !== null) return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["parentId"] } });
      }
      await client.query("UPDATE categories SET name = $1, parent_id = $2, active = $3 WHERE id = $4", [next.name, next.parentId, next.active, id]);
      const changes: [string, string | undefined][] = [];
      if (next.name !== old.rows[0].name) changes.push(["category.rename", "Category renamed"]);
      if (next.parentId !== old.rows[0].parentId) changes.push(["category.move", "Category moved"]);
      if (next.active !== old.rows[0].active) changes.push(next.active ? ["category.reactivate", "Category reactivated"] : ["category.deactivate", body.reason]);
      for (const [action, reason] of changes) {
        await client.query("INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason) VALUES ($1, $2, $3, 'category', $4)", [who.accountId, action, id, reason]);
      }
      const saved = await category(client, id);
      await client.query("COMMIT");
      return reply.code(200).send(saved);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") return reply.code(409).send({ error: { code: "CATEGORY_NAME_IN_USE" } });
      throw error;
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
}
