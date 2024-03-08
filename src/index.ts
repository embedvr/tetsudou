import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { RepomdInfo, Mirror } from "./types/tetsudou";
import { Document, Hash, MFile, Resources } from "./types/metalink";
import { HTTPException } from "hono/http-exception";
import xml from "xml-js";
import { cache } from "hono/cache";
import { selectMirrors } from "./utils/selection";

type Bindings = {
  TETSUDOU: KVNamespace;
};

const app = new Hono<{ Bindings: Bindings }>();

const metalinkParams = z.object({
  repo: z.string(),
  arch: z.string().optional(),
  country: z.string().optional(),
});

app.get("/", (c) => {
  return c.redirect("https://github.com/terrapkg/tetsudou");
});

app.get(
  "/metalink",
  cache({
    cacheName: "tetsudou",
    cacheControl: "max-age=300",
  }),
  zValidator("query", metalinkParams),
  async (c) => {
    const { repo, arch } = c.req.valid("query");

    const mirrors = await c.env.TETSUDOU.get("mirrors/" + repo);

    if (mirrors === null) {
      throw new HTTPException(404, {
        message: "No mirrors found for this repo",
      });
    }

    const mirrorList = JSON.parse(mirrors) as Mirror[];
    const archCompatibleMirrors = mirrorList.filter(
      // 1. If the mirror's arch is undefined, we assume it's an anyarch repo, and match it
      // 2. If the mirror's arch is the same as the requested arch, match it
      (mirror) => mirror.arch === undefined || mirror.arch === arch
    );
    const selectedMirrors = selectMirrors(c.req.raw, archCompatibleMirrors);

    const tetsudouMetadata = (await (
      await fetch(`https://repos.fyralabs.com/${repo}/repodata/tetsudou.json`)
    ).json()) as RepomdInfo;

    const resources: Resources = {
      _attributes: {
        maxconnections: 1,
      },
      url: selectedMirrors.flatMap((mirror) =>
        mirror.protocols.map((protocol) => ({
          _attributes: {
            type: protocol,
            protocol: protocol,
            location: mirror.country,
            preference: mirror.preference,
          },
          _text: `${protocol}://${mirror.url}/repodata/repomd.xml`,
        }))
      ),
    };

    const hashes: Hash[] = Object.entries(tetsudouMetadata.hashes).map(
      ([type, value]) => ({
        _attributes: {
          type,
        },
        _text: value,
      })
    );

    const file: MFile = {
      _attributes: {
        name: "repomd.xml",
      },
      "mm0:timestamp": tetsudouMetadata.timestamp,
      size: tetsudouMetadata.size,
      verification: { hash: hashes },
      resources,
    };

    const document: Document = {
      _declaration: {
        _attributes: {
          version: "1.0",
          encoding: "utf-8",
        },
      },
      metalink: {
        _attributes: {
          version: "3.0",
          xmlns: "http://www.metalinker.org/",
          type: "dynamic",
          generator: "tetsudou",
        },
        files: [{ file }],
      },
    };

    return c.text(xml.js2xml(document, { compact: true }));
  }
);

export default app;
