import axios from 'axios'
import { mergeDeepRight } from 'ramda'

import { notify } from '@utils/notifications'
import { WSOL_MINT } from '@components/instructions/tools'
import overrides from 'public/realms/token-overrides.json'
import { Price, TokenInfo } from './types'
import { chunks } from '@utils/helpers'
import { USDC_MINT } from '@blockworks-foundation/mango-v4'
import { useLocalStorage } from '@hooks/useLocalStorage'
import { getJupiterPricesByMintStrings } from '@hooks/queries/jupiterPrice'

//this service provide prices it is not recommended to get anything more from here besides token name or price.
//decimals from metadata can be different from the realm on chain one
// const priceEndpoint = 'https://price.jup.ag/v4/price'
const tokenListUrl = 'https://tokens.jup.ag/tokens?tags=verified'
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 // 24 hours

export type TokenInfoWithoutDecimals = Omit<TokenInfo, 'decimals'>

/** @deprecated */
class TokenPriceService {
  _tokenList: TokenInfo[]
  _tokenPriceToUSDlist: {
    [mintAddress: string]: Price
  }
  _unverifiedTokenCache: { [mintAddress: string]: TokenInfoWithoutDecimals }

  constructor() {
    this._tokenList = []
    this._tokenPriceToUSDlist = {}
    this._unverifiedTokenCache = {}
  }
  async fetchSolanaTokenList() {
    try {
      const tokens = await axios.get(tokenListUrl)
      const tokenList = tokens.data as TokenInfo[]
      if (tokenList && tokenList.length) {
        this._tokenList = tokenList.map((token) => {
          const override = overrides[token.address]

          if (override) {
            return mergeDeepRight(token, override)
          }

          return token
        })
      }
    } catch (e) {
      console.log(e)
      notify({
        type: 'error',
        message: 'unable to fetch token list',
      })
    }
  }

  async fetchSolanaTokenListV2(): Promise<TokenInfo[]> {
    const storage = useLocalStorage()
    const tokenListRaw = storage.getItem('tokenList')
    const ttl = storage.getItem('tokenListTTL')

    let tokenList: TokenInfo[] = []

    try {
      // If the data is not in storage, or the TTL has expired
      if (!tokenListRaw || !ttl || Date.now() > Number(ttl)) {
        // Fetch fresh data
        const response = await axios.get(tokenListUrl)
        const tokens = response.data as TokenInfo[]

        if (tokens && tokens.length) {
          tokenList = tokens.map((token) => {
            const override = overrides[token.address]

            if (override) {
              return mergeDeepRight(token, override)
            }

            return token
          })

          // Update cache and TTL
          storage.setItem('tokenList', JSON.stringify(tokenList))
          storage.setItem('tokenListTTL', String(Date.now() + CACHE_TTL_MS))
        }
      } else {
        // Use cached data
        tokenList = JSON.parse(tokenListRaw)
      }

      this._tokenList = tokenList
      return tokenList
    } catch (e) {
      console.log(e)
      notify({
        type: 'error',
        message: 'Unable to fetch token list',
      })
      return []
    }
  }

  async fetchTokenPrices(mintAddresses: string[]) {
    if (mintAddresses.length) {
      const tokenList = await this.fetchSolanaTokenListV2()
      const symbolMap = Object.fromEntries(
        tokenList.map((token) => [token.address, token.symbol])
      )

      //can query only 100 at once
      const mintAddressesWithSol = chunks([...mintAddresses, WSOL_MINT], 100)
      for (const mintChunk of mintAddressesWithSol) {
        try {
          const response = await getJupiterPricesByMintStrings(mintChunk)
          const priceToUsd: Price[] = response
            ? Object.entries(response).map(([address, data]) => ({
                ...data,
                mintSymbol: symbolMap[address] || 'Unknown',
                vsToken: USDC_MINT.toBase58(),
                vsTokenSymbol: 'USDC',
              }))
            : []

          const keyValue = Object.fromEntries(
            priceToUsd.map((val) => [val.id, val])
          )

          this._tokenPriceToUSDlist = {
            ...this._tokenPriceToUSDlist,
            ...keyValue,
          }
        } catch (e) {
          console.error(e)
          notify({
            type: 'error',
            message: 'unable to fetch token prices',
          })
        }
      }

      const USDC_MINT_BASE = USDC_MINT.toBase58()
      if (!this._tokenPriceToUSDlist[USDC_MINT_BASE]) {
        this._tokenPriceToUSDlist[USDC_MINT_BASE] = {
          id: USDC_MINT_BASE,
          mintSymbol: 'USDC',
          price: 1,
          vsToken: USDC_MINT_BASE,
          vsTokenSymbol: 'USDC',
        }
      }

      //override chai price if its broken
      const chaiMint = '3jsFX1tx2Z8ewmamiwSU851GzyzM2DJMq7KWW5DM8Py3'
      const chaiData = this._tokenPriceToUSDlist[chaiMint]

      if (chaiData?.price && (chaiData.price > 1.3 || chaiData.price < 0.9)) {
        this._tokenPriceToUSDlist[chaiMint] = {
          ...chaiData,
          price: 1,
        }
      }
    }
  }
  async fetchTokenPrice(mintAddress: string): Promise<number | null> {
    try {
      if (this._tokenPriceToUSDlist[mintAddress]) {
        return this._tokenPriceToUSDlist[mintAddress].price
      }

      const response = await getJupiterPricesByMintStrings([mintAddress])

      if (!response || !response[mintAddress]) {
        return null
      }

      let tokenInfo: TokenInfoWithoutDecimals | undefined =
        this._unverifiedTokenCache[mintAddress] || undefined
      if (!tokenInfo) {
        tokenInfo = (await this.getTokenInfoAsync(mintAddress)) || undefined
      }
      this._tokenPriceToUSDlist[mintAddress] = {
        id: mintAddress,
        mintSymbol: tokenInfo?.symbol || 'Unknown',
        price: response[mintAddress].price,
        vsToken: USDC_MINT.toBase58(),
        vsTokenSymbol: 'USDC',
      }
      return response[mintAddress].price
    } catch (e) {
      console.error('Error fetching token price:', e)
      return null
    }
  }
  /**
   * @deprecated
   * seriously do not use this. use fetchJupiterPrice
   */
  getUSDTokenPrice(mintAddress: string): number {
    return mintAddress ? this._tokenPriceToUSDlist[mintAddress]?.price || 0 : 0
  }
  /**
   * For decimals use on chain tryGetMint
   */
  getTokenInfo(mintAddress: string): TokenInfoWithoutDecimals | undefined {
    const tokenListRecord = this._tokenList?.find(
      (x) => x.address === mintAddress
    )
    return tokenListRecord
  }

  // This async method is used to lookup additional tokens not on JUP's strict list
  async getTokenInfoAsync(
    mintAddress: string
  ): Promise<TokenInfoWithoutDecimals | undefined> {
    let tokenInfo: TokenInfoWithoutDecimals | undefined =
      this._unverifiedTokenCache[mintAddress] || undefined
      
    if (tokenInfo) {
      return tokenInfo
    }
    if (!mintAddress || mintAddress.trim() === '') {
      return undefined
    }
    // Check the strict token list first
    let tokenListRecord = this._tokenList?.find(
      (x) => x.address === mintAddress
    )
    if (tokenListRecord) {
      return tokenListRecord
    }
    // Check the unverified token list cache next to avoid repeatedly loading token metadata
    if (this._unverifiedTokenCache[mintAddress]) {
      return this._unverifiedTokenCache[mintAddress]
    }
    // Get the token data from JUP's api
    try {
      const requestURL = `https://tokens.jup.ag/token/${mintAddress}`
      const response = await axios.get(requestURL)
      if (response.data) {
        // Remove decimals and add chainId to match the TokenInfoWithoutDecimals struct
        const { decimals, ...tokenInfoWithoutDecimals } = response.data

        const finalTokenInfo = {
          ...tokenInfoWithoutDecimals,
          chainId: 101,
        }
        // Add to unverified token cache
        this._unverifiedTokenCache[mintAddress] = finalTokenInfo
        return finalTokenInfo
      } else {
        console.error(`Metadata retrieving failed for ${mintAddress}`)
        return undefined
      }
    } catch {
      console.error(`Metadata retrieving failed for ${mintAddress}`)
      return undefined
    }
  }
  catch(e) {
    console.error(e)
    notify({
      type: 'error',
      message: 'Unable to fetch token information',
    })
    return undefined
  }

  /**
   * For decimals use on chain tryGetMint
   */
  getTokenInfoFromCoingeckoId(
    coingeckoId: string
  ): TokenInfoWithoutDecimals | undefined {
    const tokenListRecord = this._tokenList?.find(
      (x) => x.extensions?.coingeckoId === coingeckoId
    )
    return tokenListRecord
  }
}

const tokenPriceService = new TokenPriceService()

export default tokenPriceService
