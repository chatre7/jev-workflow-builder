import NextAuth from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import {
  getAuthConfigurationError,
  getAuthOptions,
} from "../../../workflow/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handler(
  request: NextRequest,
  context: { params: Promise<{ nextauth: string[] }> }
) {
  const configurationError = getAuthConfigurationError();
  if (configurationError) {
    return NextResponse.json(
      { error: configurationError },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
  return NextAuth(request, context, getAuthOptions());
}

export { handler as GET, handler as POST };
