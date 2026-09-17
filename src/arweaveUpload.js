import fs from "fs";
import bs58 from "bs58";
import { Uploader } from "@irys/upload";
import { Solana } from "@irys/upload-solana";
import { config } from "./config.js";

// Sobe a imagem gerada + o JSON de metadata pra Arweave via Irys - o
// mesmo serviço que StonkFun/Raydium usam pros próprios tokens (reparado
// nas URLs "gateway.irys.xyz" que a API deles devolve). É pago (em SOL),
// mas cada upload custa frações de centavo pro tamanho de imagem/JSON
// que a gente gera aqui.

let cachedUploader = null;

async function getUploader() {
  if (cachedUploader) return cachedUploader;
  const privateKeyBase58 = bs58.encode(config.walletKeypair.secretKey);
  cachedUploader = await Uploader(Solana).withWallet(privateKeyBase58);
  return cachedUploader;
}

// Financia o node da Irys só se o saldo já carregado estiver abaixo desse
// piso - evita reabastecer (e desperdiçar SOL parado lá) em toda chamada.
const MIN_BALANCE_LAMPORTS = 3_000_000; // 0,003 SOL
const TOP_UP_SOL = 0.01;

async function ensureFunded(uploader) {
  let currentBalance = 0;
  try {
    const balance = await uploader.getLoadedBalance();
    currentBalance = Number(balance.toString());
  } catch (err) {
    console.error("[arweaveUpload] não consegui ler saldo da Irys, vou tentar financiar mesmo assim:", err.message);
  }

  if (currentBalance >= MIN_BALANCE_LAMPORTS) return;

  console.log(`[arweaveUpload] saldo da Irys baixo (${currentBalance} lamports) - financiando com ${TOP_UP_SOL} SOL...`);
  await uploader.fund(uploader.utils.toAtomic(TOP_UP_SOL));
}

/**
 * Sobe a imagem (PNG já gerado pelo imageGen.js) + um JSON de metadata
 * padrão (name/symbol/description/image) pra Arweave. Devolve as duas
 * URLs permanentes - a de metadata é o que vai no campo "uri" do token
 * (ver tokenMinter.js).
 */
export async function uploadTokenAssets({ imagePath, name, symbol, description, contentType = "image/png" }) {
  const uploader = await getUploader();
  await ensureFunded(uploader);

  const imageBuffer = fs.readFileSync(imagePath);
  const imageReceipt = await uploader.upload(imageBuffer, {
    tags: [{ name: "Content-Type", value: contentType }],
  });
  const imageUrl = `https://gateway.irys.xyz/${imageReceipt.id}`;

  const metadata = { name, symbol, description, image: imageUrl };
  const metadataReceipt = await uploader.upload(JSON.stringify(metadata), {
    tags: [{ name: "Content-Type", value: "application/json" }],
  });
  const metadataUrl = `https://gateway.irys.xyz/${metadataReceipt.id}`;

  return { imageUrl, metadataUrl };
}
