import { MintLayout, Token } from '@solana/spl-token'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js'

import { TOKEN_PROGRAM_ID } from '@utils/tokens'

export const withCreateMint = async (
  connection: Connection,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  ownerPk: PublicKey,
  freezeAuthorityPk: PublicKey | null,
  decimals: number,
  payerPk: PublicKey,
  withSeed?: string,
  mintWithSeed?: PublicKey,
) => {
  const mintRentExempt = await connection.getMinimumBalanceForRentExemption(
    MintLayout.span
  )

  const mintAccount = new Keypair()

  if (withSeed && mintWithSeed) {
    instructions.push(
      SystemProgram.createAccountWithSeed({
        fromPubkey: payerPk,
        newAccountPubkey: mintWithSeed,
        basePubkey: payerPk,
        seed: withSeed,
        lamports: mintRentExempt,
        space: MintLayout.span,
        programId: TOKEN_PROGRAM_ID,
      })
    )
  } else {
    instructions.push(
      SystemProgram.createAccount({
        fromPubkey: payerPk,
        newAccountPubkey: mintAccount.publicKey,
        lamports: mintRentExempt,
        space: MintLayout.span,
        programId: TOKEN_PROGRAM_ID,
      })
    )
    signers.push(mintAccount)   
  }

  instructions.push(
    Token.createInitMintInstruction(
      TOKEN_PROGRAM_ID,
      mintWithSeed ?? mintAccount.publicKey,
      decimals,
      ownerPk,
      freezeAuthorityPk
    )
  )
  return mintWithSeed ?? mintAccount.publicKey
}
