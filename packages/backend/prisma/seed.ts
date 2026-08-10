import { prisma } from "../src/db.js";
import { hashPassword } from "../src/auth/passwords.js";

async function main() {
  const existing = await prisma.user.count();
  if (existing > 0) {
    console.log(`${existing} user(s) already exist, skipping seed.`);
    return;
  }

  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD environment variables are required to seed the first admin");
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { email, passwordHash, role: "ADMIN" },
  });
  console.log(`Created admin user ${user.email}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
