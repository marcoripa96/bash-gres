import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const alt = "BashGres - PostgreSQL-backed Virtual Filesystem";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const ASCII = `██████╗  █████╗ ███████╗██╗  ██╗ ██████╗ ██████╗ ███████╗███████╗
██╔══██╗██╔══██╗██╔════╝██║  ██║██╔════╝ ██╔══██╗██╔════╝██╔════╝
██████╔╝███████║███████╗███████║██║  ███╗██████╔╝█████╗  ███████╗
██╔══██╗██╔══██║╚════██║██╔══██║██║   ██║██╔══██╗██╔══╝  ╚════██║
██████╔╝██║  ██║███████║██║  ██║╚██████╔╝██║  ██║███████╗███████║
╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝╚══════╝`;

const SCATTERED_COMMANDS = [
  { text: "$ mkdir -p /data/logs", x: 40, y: 35, opacity: 0.07 },
  { text: "$ cat /etc/config.yml", x: 820, y: 50, opacity: 0.06 },
  { text: "$ echo 'hello' > /tmp/out.txt", x: 140, y: 110, opacity: 0.05 },
  { text: "$ ls -la /workspace/src", x: 750, y: 140, opacity: 0.07 },
  { text: "$ tree /project", x: 60, y: 480, opacity: 0.06 },
  { text: "$ grep -r 'TODO' /src", x: 880, y: 510, opacity: 0.05 },
  { text: "$ find / -name '*.ts'", x: 200, y: 555, opacity: 0.07 },
  { text: "$ cp -r /backup /data", x: 780, y: 570, opacity: 0.06 },
  { text: "$ rm -rf /tmp/cache", x: 900, y: 20, opacity: 0.04 },
  { text: "$ mv /old /archive", x: 30, y: 300, opacity: 0.04 },
  { text: "$ wc -l /logs/app.log", x: 900, y: 310, opacity: 0.04 },
  { text: "$ head -20 /README.md", x: 60, y: 190, opacity: 0.04 },
  { text: "$ stat /db/nodes.sql", x: 850, y: 440, opacity: 0.04 },
  { text: "$ ln -s /src /link", x: 30, y: 420, opacity: 0.05 },
];

function buildDots() {
  const dots = [];
  const spacing = 32;
  for (let y = 0; y < 630; y += spacing) {
    for (let x = 0; x < 1200; x += spacing) {
      dots.push(
        <div
          key={`${x}-${y}`}
          style={{
            position: "absolute",
            left: x,
            top: y,
            width: "1.5px",
            height: "1.5px",
            borderRadius: "50%",
            backgroundColor: "#fafafa",
            opacity: 0.08,
          }}
        />,
      );
    }
  }
  return dots;
}

export default async function Image() {
  const geistMono = await readFile(
    join(
      process.cwd(),
      "node_modules/geist/dist/fonts/geist-mono/GeistMono-Regular.ttf",
    ),
  );
  const geistMedium = await readFile(
    join(
      process.cwd(),
      "node_modules/geist/dist/fonts/geist-sans/Geist-Medium.ttf",
    ),
  );

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#09090b",
          position: "relative",
        }}
      >
        {/* Dot grid pattern */}
        {buildDots()}

        {/* Scattered commands */}
        {SCATTERED_COMMANDS.map((cmd, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: cmd.x,
              top: cmd.y,
              fontFamily: "GeistMono",
              fontSize: "14px",
              color: "#fafafa",
              opacity: cmd.opacity,
              whiteSpace: "nowrap",
            }}
          >
            {cmd.text}
          </div>
        ))}

        {/* Radial glow behind text */}
        <div
          style={{
            position: "absolute",
            width: "800px",
            height: "400px",
            borderRadius: "50%",
            background:
              "radial-gradient(ellipse, rgba(250,250,250,0.04) 0%, transparent 70%)",
          }}
        />

        {/* Content */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "36px",
            position: "relative",
          }}
        >
          <pre
            style={{
              fontFamily: "GeistMono",
              fontSize: "16px",
              lineHeight: 1.15,
              color: "#fafafa",
              whiteSpace: "pre",
              margin: 0,
            }}
          >
            {ASCII}
          </pre>
          <div
            style={{
              fontFamily: "Geist",
              fontSize: "28px",
              color: "#71717a",
              fontWeight: 500,
              letterSpacing: "-0.02em",
            }}
          >
            PostgreSQL-backed virtual filesystem with bash interface
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        {
          name: "GeistMono",
          data: geistMono,
          style: "normal",
          weight: 400,
        },
        {
          name: "Geist",
          data: geistMedium,
          style: "normal",
          weight: 500,
        },
      ],
    },
  );
}
